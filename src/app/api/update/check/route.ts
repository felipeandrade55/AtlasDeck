import { NextResponse } from "next/server";
import { checkForUpdates } from "@/lib/update";

export async function GET() {
  try {
    const result = await checkForUpdates();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
