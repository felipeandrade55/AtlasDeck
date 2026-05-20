"use client";

import { ReactNode } from "react";

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: ReactNode;
  iconColor?: string;
  subtitle?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

export function StatsCard({
  title,
  value,
  icon,
  iconColor = "var(--info)",
  subtitle,
  trend,
}: StatsCardProps) {
  return (
    <div 
      className="rounded-xl p-4 md:p-5"
      style={{
        backgroundColor: 'var(--card)',
        border: '1px solid var(--border)',
      }}
      title={subtitle}
    >
      <div className="flex items-center justify-between mb-1.5 md:mb-2">
        <span 
          className="text-xs md:text-sm font-medium"
          style={{ color: 'var(--text-secondary)' }}
        >
          {title}
        </span>
        <div className="[&>svg]:w-4 [&>svg]:h-4 md:[&>svg]:w-5 md:[&>svg]:h-5" style={{ color: iconColor }}>
          {icon}
        </div>
      </div>

      <div className="flex items-end justify-between">
        <span 
          className="text-2xl md:text-3xl font-bold tracking-tight"
          style={{ 
            fontFamily: 'var(--font-heading)',
            color: 'var(--text-primary)',
            letterSpacing: '-1.5px'
          }}
        >
          {value}
        </span>
        {trend && (
          <span
            className="text-xs md:text-sm font-medium"
            style={{ color: trend.isPositive ? 'var(--success)' : 'var(--error)' }}
          >
            {trend.isPositive ? "↑" : "↓"} {trend.value}%
          </span>
        )}
      </div>
      
      {subtitle && (
        <p 
          className="text-[10px] md:text-xs mt-1.5 line-clamp-2"
          style={{ color: 'var(--text-muted)' }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}
