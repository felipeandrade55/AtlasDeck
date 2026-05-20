"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProps {
  content: string;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <div
      className="h-full overflow-auto p-6"
      style={{ backgroundColor: "var(--card)" }}
    >
      <div className="prose prose-invert max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: (props) => (
              <a
                {...props}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)" }}
              />
            ),
            code: ({ children, className, ...props }) => {
              const inline = !className;
              if (inline) {
                return (
                  <code
                    {...props}
                    style={{
                      backgroundColor: "var(--bg)",
                      color: "var(--accent)",
                      padding: "0.125rem 0.375rem",
                      borderRadius: "0.25rem",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.875rem",
                    }}
                  >
                    {children}
                  </code>
                );
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
            pre: ({ children, ...props }) => (
              <pre
                {...props}
                style={{
                  backgroundColor: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "0.5rem",
                  padding: "1rem",
                  overflowX: "auto",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.875rem",
                }}
              >
                {children}
              </pre>
            ),
            blockquote: ({ children, ...props }) => (
              <blockquote
                {...props}
                style={{
                  borderLeft: "3px solid var(--accent)",
                  paddingLeft: "1rem",
                  margin: "0.75rem 0",
                  color: "var(--text-secondary)",
                  fontStyle: "italic",
                }}
              >
                {children}
              </blockquote>
            ),
            hr: (props) => (
              <hr
                {...props}
                style={{
                  border: "none",
                  borderTop: "1px solid var(--border)",
                  margin: "1.5rem 0",
                }}
              />
            ),
            table: ({ children, ...props }) => (
              <div style={{ overflowX: "auto", margin: "1rem 0" }}>
                <table
                  {...props}
                  style={{
                    borderCollapse: "collapse",
                    width: "100%",
                    fontSize: "0.875rem",
                  }}
                >
                  {children}
                </table>
              </div>
            ),
            th: ({ children, ...props }) => (
              <th
                {...props}
                style={{
                  border: "1px solid var(--border)",
                  padding: "0.5rem 0.75rem",
                  backgroundColor: "var(--bg)",
                  textAlign: "left",
                  color: "var(--text-primary)",
                }}
              >
                {children}
              </th>
            ),
            td: ({ children, ...props }) => (
              <td
                {...props}
                style={{
                  border: "1px solid var(--border)",
                  padding: "0.5rem 0.75rem",
                  color: "var(--text-secondary)",
                }}
              >
                {children}
              </td>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
