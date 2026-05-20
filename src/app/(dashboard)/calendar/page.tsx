import { CalendarShell } from "@/components/calendar/CalendarShell";

export const dynamic = "force-dynamic";

export default function CalendarPage() {
  return (
    <div style={{ padding: "1.5rem", height: "100%", display: "flex", flexDirection: "column" }}>
      <CalendarShell />
    </div>
  );
}
