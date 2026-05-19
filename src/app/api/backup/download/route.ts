import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { readBackupConfig } from "@/lib/backup";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const file = searchParams.get("file");

    if (!file) {
      return NextResponse.json({ error: "Missing file param" }, { status: 400 });
    }

    // Prevent directory traversal
    const config = readBackupConfig();
    const dest = path.resolve(config.destination);
    const filePath = path.join(dest, path.basename(file));

    if (!filePath.startsWith(dest) || filePath === dest) {
      return NextResponse.json({ error: "Invalid file" }, { status: 400 });
    }

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const stat = fs.statSync(filePath);
    const data = fs.readFileSync(filePath);

    const headers = new Headers();
    headers.set("Content-Type", "application/gzip");
    headers.set(
      "Content-Disposition",
      `attachment; filename="${path.basename(file)}"`
    );
    headers.set("Content-Length", String(stat.size));

    return new NextResponse(data, { headers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/backup/download] GET error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
