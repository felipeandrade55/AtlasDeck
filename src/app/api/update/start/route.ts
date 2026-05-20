import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { runBackup } from "@/lib/backup";
import {
  UpdatePhase,
  UpdateHistoryEntry,
  isUpdateRunning,
  addUpdateHistoryEntry,
  updateHistoryEntry,
  readUpdateConfig,
  getLocalVersion,
  checkForUpdates
} from "@/lib/update";

export async function POST(request: NextRequest) {
  if (isUpdateRunning()) {
    return new Response(JSON.stringify({ error: "Update is already running" }), {
      status: 409,
      headers: { "Content-Type": "application/json" }
    });
  }

  const config = readUpdateConfig();
  
  // Create history entry
  const entryId = new Date().toISOString();
  
  let fromSha = "unknown";
  try {
      const local = await getLocalVersion();
      fromSha = local.short;
  } catch(e) {}
  
  let toSha = "unknown";
  try {
      const chk = await checkForUpdates(true);
      toSha = chk.remoteSha.slice(0, 7);
  } catch(e) {}

  const initialPhases: UpdatePhase[] = [
    { name: "backup", status: config.backupBeforeUpdate ? "pending" : "skip" },
    { name: "git-pull", status: "pending" },
    { name: "npm-install", status: "pending" },
    { name: "build", status: "pending" },
    { name: "pm2-restart", status: "pending" },
    { name: "health-check", status: "pending" }
  ];

  const entry: UpdateHistoryEntry = {
    id: entryId,
    fromSha,
    toSha,
    status: "running",
    startedAt: entryId,
    phases: initialPhases,
    logs: ""
  };
  
  addUpdateHistoryEntry(entry);

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let logsBuffer = "";
        
        const send = (event: string, data: any) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        const updatePhase = (name: string, status: UpdatePhase['status'], durationSec?: number) => {
            const index = initialPhases.findIndex(p => p.name === name);
            if (index !== -1) {
                initialPhases[index].status = status;
                if (durationSec !== undefined) initialPhases[index].durationSec = durationSec;
                if (status === 'running') initialPhases[index].startedAt = new Date().toISOString();
                if (status === 'ok' || status === 'fail') initialPhases[index].completedAt = new Date().toISOString();
                
                send("phase", initialPhases[index]);
            }
        };

        const appendLog = (line: string) => {
            const timestamp = new Date().toISOString();
            logsBuffer += `[${timestamp}] ${line}\n`;
            send("log", { line, timestamp });
        };

        try {
          // Phase 1: Backup
          if (config.backupBeforeUpdate) {
            updatePhase("backup", "running");
            appendLog("Starting backup before update...");
            
            const backupResult = await runBackup();
            
            if (backupResult.success) {
              updatePhase("backup", "ok", backupResult.entry.durationMs ? Math.round(backupResult.entry.durationMs / 1000) : 0);
              appendLog(`Backup completed: ${backupResult.archivePath}`);
              updateHistoryEntry(entryId, { backupPath: backupResult.archivePath });
            } else {
              updatePhase("backup", "fail");
              appendLog(`Backup failed. Update aborted.`);
              throw new Error("Backup failed");
            }
          }

          // Phase 2-6: Deploy script
          appendLog("Starting deploy.sh --headless...");
          
          const deployScriptPath = path.join(process.cwd(), "scripts", "deploy.sh");
          
          const child = spawn("bash", [deployScriptPath, "--headless"], {
            cwd: process.cwd(),
            env: { ...process.env }
          });

          let currentPhaseName = "";
          let currentPhaseStart = 0;

          const mapDeployPhase = (text: string) => {
            const lower = text.toLowerCase();
            if (lower.includes("atualizando código") || lower.includes("clone ou pull")) return "git-pull";
            if (lower.includes("dependências")) return "npm-install";
            if (lower.includes("build")) return "build";
            if (lower.includes("gerenciando processo") || lower.includes("pm2")) return "pm2-restart";
            if (lower.includes("health check")) return "health-check";
            return "";
          };

          const handleOutput = (data: Buffer) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (!line) continue;
                
                // Clean ANSI codes
                const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                if (!cleanLine) continue;

                appendLog(cleanLine);

                // Detect phase transitions based on deploy.sh output (▶)
                if (cleanLine.startsWith("▶")) {
                    const nextPhase = mapDeployPhase(cleanLine);
                    
                    // Mark previous as ok if transitioning successfully
                    if (currentPhaseName) {
                        const durationSec = Math.round((Date.now() - currentPhaseStart) / 1000);
                        updatePhase(currentPhaseName, "ok", durationSec);
                    }
                    
                    if (nextPhase) {
                        currentPhaseName = nextPhase;
                        currentPhaseStart = Date.now();
                        updatePhase(currentPhaseName, "running");
                    }
                }
                
                // Detect explicit failures
                if (cleanLine.startsWith("✗")) {
                    if (currentPhaseName) {
                        updatePhase(currentPhaseName, "fail");
                    }
                    send("error", { message: cleanLine, phase: currentPhaseName });
                }
            }
          };

          child.stdout.on("data", handleOutput);
          child.stderr.on("data", handleOutput);

          child.on("close", (code) => {
            const durationMs = Date.now() - new Date(entry.startedAt).getTime();
            
            if (code === 0) {
                // Mark last phase as ok
                if (currentPhaseName) {
                    const durationSec = Math.round((Date.now() - currentPhaseStart) / 1000);
                    updatePhase(currentPhaseName, "ok", durationSec);
                }
                
                // Any pending phases not reached are likely skipped (e.g. npm install if no changes)
                initialPhases.forEach(p => {
                    if (p.status === 'pending' || p.status === 'running') {
                        updatePhase(p.name, p.status === 'running' ? 'ok' : 'skip');
                    }
                });

                updateHistoryEntry(entryId, {
                    status: "success",
                    completedAt: new Date().toISOString(),
                    durationMs,
                    phases: initialPhases,
                    logs: logsBuffer
                });
                
                send("complete", { success: true, durationMs, phases: initialPhases });
            } else {
                updateHistoryEntry(entryId, {
                    status: "error",
                    completedAt: new Date().toISOString(),
                    durationMs,
                    phases: initialPhases,
                    logs: logsBuffer,
                    error: `Exit code ${code}`
                });
                
                send("complete", { success: false, durationMs, phases: initialPhases, error: `Exit code ${code}` });
            }
            controller.close();
          });

          child.on("error", (err) => {
              appendLog(`Failed to start child process: ${err.message}`);
              updateHistoryEntry(entryId, {
                  status: "error",
                  completedAt: new Date().toISOString(),
                  error: err.message,
                  logs: logsBuffer
              });
              send("complete", { success: false, phases: initialPhases, error: err.message });
              controller.close();
          });

        } catch (error) {
            const msg = error instanceof Error ? error.message : "Unknown error";
            appendLog(`Fatal error: ${msg}`);
            updateHistoryEntry(entryId, {
                status: "error",
                completedAt: new Date().toISOString(),
                error: msg,
                logs: logsBuffer
            });
            send("complete", { success: false, phases: initialPhases, error: msg });
            controller.close();
        }
      }
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      }
    }
  );
}
