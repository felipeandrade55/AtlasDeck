/**
 * Source of the AtlasDeck VPS agent (Python 3, stdlib only).
 *
 * Served verbatim by /api/vps/agent.py and embedded by /api/vps/install into
 * the bash installer. Kept here as a single source of truth so both routes
 * ship the exact same code.
 *
 * The agent: collects host metrics from /proc, top-N processes, configured
 * systemd services and (auto) Docker containers; writes each sample to a
 * local NDJSON spool first; then flushes the spool in batches to the
 * AtlasDeck ingest endpoint, deleting lines only on a 2xx response (so it
 * survives AtlasDeck downtime and the window before the token is enrolled).
 */
export const AGENT_VERSION = '1.0.0';

export const AGENT_PY = String.raw`#!/usr/bin/env python3
# AtlasDeck VPS agent - stdlib only. Runs as a systemd service.
import os, sys, json, time, socket, shutil, subprocess, urllib.request

CONFIG_PATH = "/etc/atlasdeck-agent/config.json"
AGENT_VERSION = "1.0.0"

def load_config():
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
NCPU = os.cpu_count() or 1

_prev_cpu = None        # (total, idle)
_prev_net = None        # (rx, tx, ts)
_prev_proc = {}         # pid -> (utime+stime)
_prev_proc_total = None # total cpu jiffies for proc delta

def read_cpu_usage():
    global _prev_cpu
    try:
        with open("/proc/stat", "r") as f:
            line = f.readline()
        parts = [float(x) for x in line.split()[1:]]
        idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
        total = sum(parts)
        if _prev_cpu is None:
            _prev_cpu = (total, idle)
            return None
        dt = total - _prev_cpu[0]
        di = idle - _prev_cpu[1]
        _prev_cpu = (total, idle)
        if dt <= 0:
            return None
        return round(max(0.0, min(100.0, (1.0 - di / dt) * 100.0)), 1)
    except Exception:
        return None

def read_mem():
    out = {}
    try:
        info = {}
        with open("/proc/meminfo", "r") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k.strip()] = float(v.split()[0])  # kB
        mt = info.get("MemTotal", 0.0)
        ma = info.get("MemAvailable", info.get("MemFree", 0.0))
        if mt > 0:
            out["ram_used_pct"] = round((mt - ma) / mt * 100.0, 1)
        st = info.get("SwapTotal", 0.0)
        sf = info.get("SwapFree", 0.0)
        if st > 0:
            out["swap_used_pct"] = round((st - sf) / st * 100.0, 1)
        else:
            out["swap_used_pct"] = 0.0
        out["_mem_total_kb"] = mt
    except Exception:
        pass
    return out

def read_load():
    out = {}
    try:
        with open("/proc/loadavg", "r") as f:
            p = f.read().split()
        out["load1"] = float(p[0]); out["load5"] = float(p[1]); out["load15"] = float(p[2])
        out["load1_per_core"] = round(out["load1"] / NCPU, 2)
    except Exception:
        pass
    return out

def read_uptime():
    try:
        with open("/proc/uptime", "r") as f:
            return float(f.read().split()[0])
    except Exception:
        return None

def read_net():
    global _prev_net
    try:
        rx = 0; tx = 0
        with open("/proc/net/dev", "r") as f:
            for line in f.readlines()[2:]:
                iface, _, rest = line.partition(":")
                iface = iface.strip()
                if iface == "lo":
                    continue
                cols = rest.split()
                rx += int(cols[0]); tx += int(cols[8])
        now = time.time()
        if _prev_net is None:
            _prev_net = (rx, tx, now)
            return {}
        drx = rx - _prev_net[0]; dtx = tx - _prev_net[1]; dts = now - _prev_net[2]
        _prev_net = (rx, tx, now)
        if dts <= 0:
            return {}
        return {
            "net_rx_mbps": round(max(0.0, drx / dts) / 1024 / 1024, 3),
            "net_tx_mbps": round(max(0.0, dtx / dts) / 1024 / 1024, 3),
        }
    except Exception:
        return {}

PSEUDO_FS = set(["proc","sysfs","cgroup","cgroup2","tmpfs","devtmpfs","devpts",
                 "overlay","squashfs","mqueue","debugfs","tracefs","securityfs",
                 "pstore","autofs","fusectl","configfs","ramfs","bpf","nsfs","hugetlbfs"])

def read_disks():
    disks = []
    worst = 0.0
    seen = set()
    try:
        with open("/proc/mounts", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                mount, fstype = parts[1], parts[2]
                if fstype in PSEUDO_FS:
                    continue
                if mount in seen:
                    continue
                seen.add(mount)
                try:
                    u = shutil.disk_usage(mount)
                except Exception:
                    continue
                if u.total <= 0:
                    continue
                pct = round(u.used / u.total * 100.0, 1)
                disks.append({
                    "mount": mount,
                    "totalGb": round(u.total / 1024**3, 1),
                    "usedGb": round(u.used / 1024**3, 1),
                    "pct": pct,
                })
                if pct > worst:
                    worst = pct
    except Exception:
        pass
    return disks, worst

def read_top_processes(top_n, mem_total_kb):
    global _prev_proc, _prev_proc_total
    procs = []
    cur = {}
    try:
        with open("/proc/stat", "r") as f:
            total_now = sum(float(x) for x in f.readline().split()[1:])
    except Exception:
        total_now = None
    dtotal = None
    if _prev_proc_total is not None and total_now is not None:
        dtotal = total_now - _prev_proc_total
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/" + pid + "/stat", "r") as f:
                st = f.read()
            rp = st.rfind(")")
            fields = st[rp + 2:].split()
            utime = float(fields[11]); stime = float(fields[12])
            jiff = utime + stime
            cur[pid] = jiff
            cpu = 0.0
            if pid in _prev_proc and dtotal and dtotal > 0:
                cpu = max(0.0, (jiff - _prev_proc[pid]) / dtotal * 100.0)
            name = st[st.find("(") + 1:rp]
            rss_kb = 0.0
            try:
                with open("/proc/" + pid + "/status", "r") as f:
                    for line in f:
                        if line.startswith("VmRSS:"):
                            rss_kb = float(line.split()[1]); break
            except Exception:
                pass
            mem_pct = round(rss_kb / mem_total_kb * 100.0, 1) if mem_total_kb else 0.0
            cmd = ""
            try:
                with open("/proc/" + pid + "/cmdline", "rb") as f:
                    cmd = f.read().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
            except Exception:
                pass
            procs.append({"pid": int(pid), "name": name, "cpu": round(cpu, 1),
                          "memPct": mem_pct, "cmd": cmd[:200]})
        except Exception:
            continue
    _prev_proc = cur
    _prev_proc_total = total_now
    procs.sort(key=lambda p: (p["cpu"], p["memPct"]), reverse=True)
    return procs[:top_n]

def read_services(services):
    out = []
    for svc in services or []:
        name = svc.get("name")
        if not name:
            continue
        stype = svc.get("type", "systemd")
        active = False; detail = ""
        try:
            if stype == "docker":
                r = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", name],
                                   capture_output=True, text=True, timeout=10)
                active = r.stdout.strip() == "true"
                detail = r.stdout.strip() or r.stderr.strip()
            else:
                r = subprocess.run(["systemctl", "is-active", name],
                                   capture_output=True, text=True, timeout=10)
                detail = r.stdout.strip()
                active = detail == "active"
        except Exception as e:
            detail = str(e)
        out.append({"type": stype, "name": name, "active": active, "detail": detail})
    return out

def docker_available():
    try:
        r = subprocess.run(["docker", "version", "--format", "{{.Server.Version}}"],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0
    except Exception:
        return False

_docker_tick = 0
_docker_stats_cache = {}

def read_docker(stats_every):
    global _docker_tick, _docker_stats_cache
    if not shutil.which("docker"):
        return {"installed": False}
    running = docker_available()
    if not running:
        return {"installed": True, "running": False, "containers": []}
    containers = []
    try:
        r = subprocess.run(["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"],
                           capture_output=True, text=True, timeout=15)
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                c = json.loads(line)
            except Exception:
                continue
            containers.append({
                "id": (c.get("ID") or "")[:12],
                "name": c.get("Names") or c.get("Name") or "",
                "image": c.get("Image") or "",
                "state": (c.get("State") or "").lower(),
                "status": c.get("Status") or "",
            })
    except Exception:
        pass
    _docker_tick += 1
    if stats_every > 0 and (_docker_tick % stats_every == 1 or stats_every == 1):
        _docker_stats_cache = {}
        try:
            r = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{json .}}"],
                               capture_output=True, text=True, timeout=20)
            for line in r.stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    s = json.loads(line)
                except Exception:
                    continue
                nm = s.get("Name") or ""
                cpu = _pct(s.get("CPUPerc"))
                mem = _pct(s.get("MemPerc"))
                _docker_stats_cache[nm] = {"cpu": cpu, "memPct": mem}
        except Exception:
            pass
    for c in containers:
        st = _docker_stats_cache.get(c["name"])
        if st:
            c["cpu"] = st["cpu"]; c["memPct"] = st["memPct"]
    return {"installed": True, "running": True, "containers": containers}

def _pct(v):
    try:
        return round(float(str(v).replace("%", "").strip()), 1)
    except Exception:
        return None

def os_pretty_name():
    try:
        with open("/etc/os-release", "r") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return sys.platform

def collect(cfg):
    metrics = {}
    cpu = read_cpu_usage()
    if cpu is not None:
        metrics["cpu_usage"] = cpu
    mem = read_mem()
    mem_total_kb = mem.pop("_mem_total_kb", 0.0)
    metrics.update(mem)
    metrics.update(read_load())
    metrics.update(read_net())
    up = read_uptime()
    if up is not None:
        metrics["uptime_sec"] = round(up)
    disks, worst = read_disks()
    metrics["disk_used_pct"] = worst
    sample = {
        "ts": int(time.time() * 1000),
        "metrics": metrics,
        "processes": read_top_processes(int(cfg.get("topN", 10)), mem_total_kb),
        "services": read_services(cfg.get("services", [])),
        "disks": disks,
        "docker": read_docker(int(cfg.get("dockerStatsEveryTicks", 2))),
    }
    return sample

def spool_append(path, max_bytes, sample):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(sample) + "\n")
            f.flush()
            os.fsync(f.fileno())
        if os.path.getsize(path) > max_bytes:
            with open(path, "r") as f:
                lines = f.readlines()
            # keep the newest half that fits
            keep = lines[len(lines) // 2:]
            with open(path, "w") as f:
                f.writelines(keep)
    except Exception as e:
        print("spool error:", e, file=sys.stderr)

def flush(cfg):
    path = cfg["spoolPath"]
    if not os.path.exists(path):
        return
    try:
        with open(path, "r") as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
    except Exception:
        return
    if not lines:
        return
    batch = lines[:500]
    samples = []
    for l in batch:
        try:
            samples.append(json.loads(l))
        except Exception:
            pass
    body = {
        "agentVersion": AGENT_VERSION,
        "hostname": socket.gethostname(),
        "os": os_pretty_name(),
        "samples": samples,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(cfg["ingestUrl"], data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-vps-token", cfg["token"])
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            ok = 200 <= resp.status < 300
    except Exception as e:
        print("flush failed (will retry):", e, file=sys.stderr)
        return
    if ok:
        remaining = lines[len(batch):]
        with open(path, "w") as f:
            if remaining:
                f.write("\n".join(remaining) + "\n")

def main():
    cfg = load_config()
    interval = int(cfg.get("intervalSec", 30))
    spool_max = int(cfg.get("spoolMaxBytes", 10485760))
    print("atlasdeck-agent started; ingest=" + cfg.get("ingestUrl", "?"), file=sys.stderr)
    # prime CPU/net deltas
    read_cpu_usage(); read_net()
    time.sleep(1)
    while True:
        try:
            sample = collect(cfg)
            spool_append(cfg["spoolPath"], spool_max, sample)
            flush(cfg)
        except Exception as e:
            print("tick error:", e, file=sys.stderr)
        time.sleep(interval)

if __name__ == "__main__":
    main()
`;
