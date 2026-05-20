import type { ReactNode } from "react";

export const metadata = {
  title: "Agende um horário",
  description: "Escolha um slot livre para marcar uma reunião.",
};

export default function PublicBookingLayout({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: "100vh", backgroundColor: "var(--bg)" }}>{children}</div>;
}
