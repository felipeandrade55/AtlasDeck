import { NextRequest, NextResponse } from "next/server";
import { deleteBookingLink, getBookingLinkById, updateBookingLink } from "@/lib/calendar-db";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const link = getBookingLinkById(id);
    if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ link });
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const link = updateBookingLink(id, body);
    if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ link });
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const ok = deleteBookingLink(id);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
