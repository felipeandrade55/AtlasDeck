"use client";

import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AggPoint } from "@/lib/metrics-db";

export interface MetricChartProps {
  data: AggPoint[];
  color: string;
  unit?: string;
  height?: number;
  yDomain?: [number, number] | "auto";
  /** Show a thin range pill bar above the chart with min/avg/max stats. */
  showStats?: boolean;
  /** Decimal places in tooltip & stat numbers. */
  precision?: number;
  /** Locale-aware label for the tooltip (e.g. "CPU"). */
  label?: string;
}

const CHART_COLORS = {
  border: "#2A2A2A",
  card: "#1A1A1A",
  textMuted: "#666666",
  textSecondary: "#8A8A8A",
  textPrimary: "#FFFFFF",
};

interface ChartRow {
  ts: number;
  avg: number;
  /** Used by Area to draw the min/max band. */
  range: [number, number];
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTsLong(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MetricChart({
  data,
  color,
  unit = "%",
  height = 140,
  yDomain = "auto",
  showStats = true,
  precision = 1,
  label = "valor",
}: MetricChartProps) {
  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-xs rounded-lg"
        style={{
          height,
          color: CHART_COLORS.textMuted,
          backgroundColor: "rgba(255,255,255,0.02)",
          border: "1px dashed rgba(255,255,255,0.08)",
        }}
      >
        Coletando dados…
      </div>
    );
  }

  const rows: ChartRow[] = data.map(p => ({
    ts: p.ts,
    avg: p.avg,
    range: [p.min, p.max],
  }));

  const mins = data.map(p => p.min);
  const maxs = data.map(p => p.max);
  const avgs = data.map(p => p.avg);
  const minOverall = Math.min(...mins);
  const maxOverall = Math.max(...maxs);
  const avgOverall = avgs.reduce((a, b) => a + b, 0) / avgs.length;

  const gradientId = `grad-${Math.abs(hashStr(color))}`;

  return (
    <div className="w-full">
      {showStats && (
        <div
          className="flex items-center justify-between text-[10px] uppercase tracking-wide mb-1.5 px-0.5"
          style={{ color: CHART_COLORS.textMuted }}
        >
          <span>
            min{" "}
            <span style={{ color: CHART_COLORS.textSecondary }}>
              {minOverall.toFixed(precision)}
              {unit}
            </span>
          </span>
          <span>
            méd{" "}
            <span style={{ color }}>
              {avgOverall.toFixed(precision)}
              {unit}
            </span>
          </span>
          <span>
            max{" "}
            <span style={{ color: CHART_COLORS.textSecondary }}>
              {maxOverall.toFixed(precision)}
              {unit}
            </span>
          </span>
        </div>
      )}
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="ts"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              stroke={CHART_COLORS.textMuted}
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatTs}
              minTickGap={48}
            />
            <YAxis
              stroke={CHART_COLORS.textMuted}
              fontSize={10}
              tickLine={false}
              axisLine={false}
              width={32}
              domain={yDomain === "auto" ? ["dataMin", "dataMax"] : yDomain}
              tickFormatter={v =>
                `${typeof v === "number" ? v.toFixed(precision === 0 ? 0 : 0) : v}`
              }
            />
            <Tooltip
              contentStyle={{
                backgroundColor: CHART_COLORS.card,
                border: `1px solid ${CHART_COLORS.border}`,
                borderRadius: "8px",
                color: CHART_COLORS.textPrimary,
                fontSize: "12px",
              }}
              labelStyle={{ color: CHART_COLORS.textSecondary }}
              labelFormatter={ts => formatTsLong(Number(ts))}
              formatter={(value, name) => {
                if (name === "range") {
                  const [lo, hi] = value as [number, number];
                  return [
                    `${lo.toFixed(precision)}${unit} – ${hi.toFixed(precision)}${unit}`,
                    "min · max",
                  ];
                }
                return [
                  `${(value as number).toFixed(precision)}${unit}`,
                  label,
                ];
              }}
            />
            <Area
              type="monotone"
              dataKey="range"
              stroke="none"
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="avg"
              stroke={color}
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
