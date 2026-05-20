import { NextRequest, NextResponse } from "next/server";
import { removeBlock } from "@/lib/calendar-blocks";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const ok = removeBlock(id);
    if (!ok) return NextResponse.json({ error: "Block not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete block:", error);
    return NextResponse.json({ error: "Failed to delete block" }, { status: 500 });
  }
}
