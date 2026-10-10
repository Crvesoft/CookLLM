import React, { useMemo } from "react";
import { Link2 } from "lucide-react";
import { openExternal } from "../tauri";

interface ListItemNode {
  level: number;
  content: string;
  children: ListItemNode[];
}

type BlockNode =
  | { type: "heading"; level: number; content: string }
  | { type: "ul"; tree: ListItemNode[] }
  | { type: "ol"; tree: ListItemNode[] }
  | { type: "paragraph"; content: string }
  | { type: "hr" };

function buildListTree(items: { level: number; content: string }[]): ListItemNode[] {
  const root: ListItemNode[] = [];
  const stack: { level: number; children: ListItemNode[] }[] = [{ level: -1, children: root }];

  for (const item of items) {
    const node: ListItemNode = { ...item, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root;
}

function parseMarkdown(md: string): BlockNode[] {
  const lines = md.split(/\r?\n/);
  const blocks: BlockNode[] = [];
  let currentList: { type: "ul" | "ol"; items: { level: number; content: string }[] } | null = null;

  function flushList() {
    if (currentList) {
      blocks.push({
        type: currentList.type,
        tree: buildListTree(currentList.items),
      });
      currentList = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      flushList();
      continue;
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      flushList();
      blocks.push({ type: "hr" });
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushList();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      continue;
    }

    // Unordered list item: - / * / +
    const listMatch = rawLine.match(/^(\s*)([-*+])\s+(.*)$/);
    if (listMatch) {
      const indentSpaces = listMatch[1].length;
      const level = Math.floor(indentSpaces / 2);
      if (!currentList || currentList.type !== "ul") {
        flushList();
        currentList = { type: "ul", items: [] };
      }
      currentList.items.push({ level, content: listMatch[3] });
      continue;
    }

    // Ordered list item: 1.
    const olMatch = rawLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      const indentSpaces = olMatch[1].length;
      const level = Math.floor(indentSpaces / 2);
      if (!currentList || currentList.type !== "ol") {
        flushList();
        currentList = { type: "ol", items: [] };
      }
      currentList.items.push({ level, content: olMatch[3] });
      continue;
    }

    // Paragraph
    flushList();
    blocks.push({ type: "paragraph", content: trimmed });
  }

  flushList();
  return blocks;
}

function renderInline(text: string): React.ReactNode {
  // Regex to match **bold**, `code`, [link](url), *italic*
  const regex = /(\*\*|__)(.+?)\1|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|(\*|_)([^*_]+)\7/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      // Bold
      nodes.push(<strong key={keyIndex++}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      // Code
      nodes.push(<code key={keyIndex++} className="changelog-inline-code">{match[3]}</code>);
    } else if (match[4] !== undefined && match[5] !== undefined) {
      // Link
      const linkText = match[4];
      const linkUrl = match[5];
      nodes.push(
        <a
          key={keyIndex++}
          href={linkUrl}
          className="changelog-link"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            void openExternal(linkUrl);
          }}
        >
          {linkText}
        </a>
      );
    } else if (match[8] !== undefined) {
      // Italic
      nodes.push(<em key={keyIndex++}>{match[8]}</em>);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length === 1 && typeof nodes[0] === "string" ? nodes[0] : nodes;
}

function renderList(nodes: ListItemNode[], isOrdered: boolean, level: number = 0): React.ReactNode {
  const ListTag = isOrdered ? "ol" : "ul";
  const listClass = `changelog-list changelog-list-level-${level} ${isOrdered ? "ordered" : "unordered"}`;

  return (
    <ListTag className={listClass}>
      {nodes.map((node, i) => (
        <li key={i} className={`changelog-item changelog-item-level-${level}`}>
          <div className="changelog-item-text">{renderInline(node.content)}</div>
          {node.children.length > 0 && renderList(node.children, isOrdered, level + 1)}
        </li>
      ))}
    </ListTag>
  );
}

export default function ChangelogViewer({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content.trim()), [content]);

  if (!blocks.length) return null;

  return (
    <div className="changelog-markdown-root">
      {blocks.map((block, idx) => {
        if (block.type === "heading") {
          const isVersion = /^v?\d+\.\d+/i.test(block.content.trim());
          if (block.level === 1 || block.level === 2) {
            return (
              <div key={idx} className="changelog-heading-version">
                {isVersion && <Link2 size={13} className="changelog-version-icon" />}
                <span>{renderInline(block.content)}</span>
              </div>
            );
          }
          if (block.level === 3 || block.level === 4) {
            return (
              <h4 key={idx} className="changelog-heading-section">
                {renderInline(block.content)}
              </h4>
            );
          }
          return (
            <h5 key={idx} className="changelog-heading-sub">
              {renderInline(block.content)}
            </h5>
          );
        }

        if (block.type === "ul") {
          return <React.Fragment key={idx}>{renderList(block.tree, false, 0)}</React.Fragment>;
        }

        if (block.type === "ol") {
          return <React.Fragment key={idx}>{renderList(block.tree, true, 0)}</React.Fragment>;
        }

        if (block.type === "hr") {
          return <hr key={idx} className="changelog-hr" />;
        }

        return (
          <p key={idx} className="changelog-paragraph">
            {renderInline(block.content)}
          </p>
        );
      })}
    </div>
  );
}
