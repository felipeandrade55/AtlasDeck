import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { MEMORY_DIR, ROOT_FILES, sanitizeWorkspaceRelativePath } from "@/lib/memory-files";
import { resolveWorkspacePath } from "@/lib/workspace-resolver";
import { indexFile } from "@/lib/memory-fts";

interface FileNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileNode[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getFileTree(workspacePath: string): Promise<FileNode[]> {
  const tree: FileNode[] = [];

  for (const file of ROOT_FILES) {
    const fullPath = path.join(workspacePath, file);
    if (await fileExists(fullPath)) {
      tree.push({ name: file, path: file, type: "file" });
    }
  }

  const memoryPath = path.join(workspacePath, MEMORY_DIR);
  if (await fileExists(memoryPath)) {
    const memoryStats = await fs.stat(memoryPath);
    if (memoryStats.isDirectory()) {
      const memoryFiles = await fs.readdir(memoryPath);
      const children: FileNode[] = [];

      for (const file of memoryFiles.sort().reverse()) {
        if (file.endsWith(".md")) {
          children.push({
            name: file,
            path: `${MEMORY_DIR}/${file}`,
            type: "file",
          });
        }
      }

      if (children.length > 0) {
        tree.push({
          name: MEMORY_DIR,
          path: MEMORY_DIR,
          type: "folder",
          children,
        });
      }
    }
  }

  return tree;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspace = searchParams.get("workspace") || "workspace";
  const filePath = searchParams.get("path");

  try {
    const workspacePath = resolveWorkspacePath(workspace);
    if (!workspacePath) {
      return NextResponse.json({ error: "Unknown workspace" }, { status: 400 });
    }

    if (!(await fileExists(workspacePath))) {
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 404 },
      );
    }

    if (!filePath) {
      const tree = await getFileTree(workspacePath);
      return NextResponse.json(tree);
    }

    const safePath = sanitizeWorkspaceRelativePath(filePath);
    if (!safePath) {
      return NextResponse.json(
        { error: "Invalid file path" },
        { status: 400 },
      );
    }

    const fullPath = path.join(workspacePath, safePath);
    if (!(await fileExists(fullPath))) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const content = await fs.readFile(fullPath, "utf-8");
    return NextResponse.json({ path: safePath, content });
  } catch (error) {
    console.error("Error reading file:", error);
    return NextResponse.json(
      { error: "Failed to read file" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { workspace = "workspace", path: filePath, content } = body;

    if (!filePath || typeof content !== "string") {
      return NextResponse.json(
        { error: "Missing path or content" },
        { status: 400 },
      );
    }

    const safePath = sanitizeWorkspaceRelativePath(filePath);
    if (!safePath) {
      return NextResponse.json(
        { error: "Invalid file path" },
        { status: 400 },
      );
    }

    const workspacePath = resolveWorkspacePath(workspace);
    if (!workspacePath) {
      return NextResponse.json({ error: "Unknown workspace" }, { status: 400 });
    }

    if (!(await fileExists(workspacePath))) {
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 404 },
      );
    }

    const fullPath = path.join(workspacePath, safePath);

    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");

    // Keep FTS index in sync. Errors are swallowed inside indexFile.
    await indexFile(workspace, safePath, fullPath);

    return NextResponse.json({ success: true, path: safePath });
  } catch (error) {
    console.error("Error saving file:", error);
    return NextResponse.json(
      { error: "Failed to save file" },
      { status: 500 },
    );
  }
}
