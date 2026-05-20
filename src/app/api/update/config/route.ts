import { NextRequest, NextResponse } from "next/server";
import { readUpdateConfig, writeUpdateConfig } from "@/lib/update";

export async function GET() {
  try {
    const config = readUpdateConfig();
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const config = writeUpdateConfig(body);
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
