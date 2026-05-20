"use client";

import { useMemo } from "react";
import {
  addDays,
  addMonths,
  endOfDay,
  endOfMonth,
  endOfWeek,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";

export type CalendarView = "day" | "week" | "month" | "agenda";

export interface CalendarRange {
  from: Date;
  to: Date;
  label: string;
}

const MONTHS_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

export function useCalendarRange(view: CalendarView, focusDate: Date): CalendarRange {
  return useMemo(() => {
    switch (view) {
      case "day": {
        const from = startOfDay(focusDate);
        const to = endOfDay(focusDate);
        return {
          from,
          to,
          label: `${focusDate.getDate()} de ${MONTHS_PT[focusDate.getMonth()]} de ${focusDate.getFullYear()}`,
        };
      }
      case "week": {
        const from = startOfWeek(focusDate, { weekStartsOn: 1 });
        const to = endOfWeek(focusDate, { weekStartsOn: 1 });
        const month = MONTHS_PT[from.getMonth()];
        return {
          from,
          to,
          label: `${month.charAt(0).toUpperCase() + month.slice(1)} ${from.getFullYear()}`,
        };
      }
      case "month": {
        const monthStart = startOfMonth(focusDate);
        const monthEnd = endOfMonth(focusDate);
        const from = startOfWeek(monthStart, { weekStartsOn: 1 });
        const to = endOfWeek(monthEnd, { weekStartsOn: 1 });
        return {
          from,
          to,
          label: `${MONTHS_PT[focusDate.getMonth()].charAt(0).toUpperCase() + MONTHS_PT[focusDate.getMonth()].slice(1)} ${focusDate.getFullYear()}`,
        };
      }
      case "agenda": {
        const from = startOfDay(focusDate);
        const to = endOfDay(addDays(focusDate, 30));
        return {
          from,
          to,
          label: "Próximos 30 dias",
        };
      }
      default:
        return { from: focusDate, to: addMonths(focusDate, 1), label: "" };
    }
  }, [view, focusDate]);
}

export function navigateDate(view: CalendarView, current: Date, direction: 1 | -1): Date {
  switch (view) {
    case "day":
      return addDays(current, direction);
    case "week":
      return addDays(current, 7 * direction);
    case "month":
      return addMonths(current, direction);
    case "agenda":
      return addDays(current, 30 * direction);
    default:
      return current;
  }
}
