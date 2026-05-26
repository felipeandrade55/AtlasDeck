import { NextRequest, NextResponse } from "next/server";
import { markRead, markDelivered, deleteMail } from "@/lib/mailbox-db";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    let updated = null;
    if (body.mark === "read") updated = markRead(id);
    else if (body.mark === "delivered") updated = markDelivered(id);
    else
      return NextResponse.json(
        { error: "body.mark must be 'read' or 'delivered'" },
        { status: 400 },
      );
    if (!updated) return NextResponse.json({ error: "Message not found" }, { status: 404 });
    return NextResponse.json({ message: updated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const ok = deleteMail(id);
    if (!ok) return NextResponse.json({ error: "Message not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
