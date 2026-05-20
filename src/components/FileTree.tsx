"use client";

import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  Brain,
  User,
  Ghost,
  BookOpen,
  Pencil,
  Trash2,
  Plus,
} from "lucide-react";

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileNode[];
}

interface FileTreeProps {
  files: FileNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onRename?: (node: FileNode) => void;
  onDelete?: (node: FileNode) => void;
  onCreateInFolder?: (folderPath: string) => void;
  protectedPaths?: ReadonlySet<string>;
}

const getFileIcon = (name: string) => {
  const lower = name.toLowerCase();
  if (lower === "memory.md") return Brain;
  if (lower === "soul.md") return Ghost;
  if (lower === "user.md") return User;
  if (lower === "agents.md") return BookOpen;
  return FileText;
};

function TreeNode({
  node,
  selectedPath,
  onSelect,
  onRename,
  onDelete,
  onCreateInFolder,
  protectedPaths,
  depth = 0,
}: {
  node: FileNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onRename?: (node: FileNode) => void;
  onDelete?: (node: FileNode) => void;
  onCreateInFolder?: (folderPath: string) => void;
  protectedPaths?: ReadonlySet<string>;
  depth?: number;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  const isSelected = selectedPath === node.path;
  const isFolder = node.type === "folder";
  const isProtected = protectedPaths?.has(node.name) ?? false;

  const handleClick = () => {
    if (isFolder) {
      setIsExpanded(!isExpanded);
    } else {
      onSelect(node.path);
    }
  };

  const Icon = isFolder
    ? isExpanded
      ? FolderOpen
      : Folder
    : getFileIcon(node.name);

  const canRename = !isFolder && !isProtected && !!onRename;
  const canDelete = !isProtected && !!onDelete;
  const canCreate = isFolder && !!onCreateInFolder;
  const hasActions = canRename || canDelete || canCreate;

  return (
    <div>
      <div
        className="relative group"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          onClick={handleClick}
          className="w-full flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-1.5 md:py-2 text-xs md:text-sm rounded-lg transition-colors"
          style={{
            paddingLeft: `${8 + depth * 12}px`,
            paddingRight: hasActions ? 56 : undefined,
            backgroundColor: isSelected ? "var(--accent)" : "transparent",
            color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
          }}
          onMouseEnter={(e) => {
            if (!isSelected) {
              e.currentTarget.style.backgroundColor = "var(--border)";
              e.currentTarget.style.color = "var(--text-primary)";
            }
          }}
          onMouseLeave={(e) => {
            if (!isSelected) {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "var(--text-secondary)";
            }
          }}
        >
          {isFolder && (
            <span className="w-3.5 h-3.5 md:w-4 md:h-4 flex items-center justify-center">
              {isExpanded ? (
                <ChevronDown className="w-3 h-3 md:w-3.5 md:h-3.5" />
              ) : (
                <ChevronRight className="w-3 h-3 md:w-3.5 md:h-3.5" />
              )}
            </span>
          )}
          {!isFolder && <span className="w-3.5 md:w-4" />}
          <Icon
            className="w-3.5 h-3.5 md:w-4 md:h-4"
            style={{
              color: isFolder
                ? "#F59E0B"
                : isSelected
                ? "var(--text-primary)"
                : "#60A5FA",
            }}
          />
          <span className="truncate">{node.name}</span>
        </button>

        {hasActions && isHovered && (
          <div
            style={{
              position: "absolute",
              right: 6,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              gap: 2,
            }}
          >
            {canCreate && (
              <button
                type="button"
                aria-label={`Criar arquivo em ${node.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateInFolder?.(node.path);
                }}
                style={iconButtonStyle}
                title="Nova memória nesta pasta"
              >
                <Plus size={12} />
              </button>
            )}
            {canRename && (
              <button
                type="button"
                aria-label={`Renomear ${node.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRename?.(node);
                }}
                style={iconButtonStyle}
                title="Renomear"
              >
                <Pencil size={12} />
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                aria-label={`Excluir ${node.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete?.(node);
                }}
                style={iconButtonStyle}
                title="Excluir"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {isFolder && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
              onCreateInFolder={onCreateInFolder}
              protectedPaths={protectedPaths}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  padding: 4,
  borderRadius: 4,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 0,
};

export function FileTree({
  files,
  selectedPath,
  onSelect,
  onRename,
  onDelete,
  onCreateInFolder,
  protectedPaths,
}: FileTreeProps) {
  return (
    <div className="py-1 md:py-2">
      {files.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          onCreateInFolder={onCreateInFolder}
          protectedPaths={protectedPaths}
        />
      ))}
    </div>
  );
}
