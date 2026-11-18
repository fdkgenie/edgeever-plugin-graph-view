import type { ExtractedNoteRef, MemoLinkRef, WikiLinkRef } from "./types";

const MEMO_LINK_PREFIX = "#memo=";

export const parseInternalMemoHref = (href: unknown): string | null => {
  if (typeof href !== "string" || !href.trim()) return null;
  const trimmed = href.trim();

  const hashIndex = trimmed.lastIndexOf("#");
  const hash = hashIndex >= 0 ? trimmed.slice(hashIndex) : trimmed;
  if (hash.startsWith(MEMO_LINK_PREFIX)) {
    const encoded = hash.slice(MEMO_LINK_PREFIX.length);
    if (!encoded) return null;
    try {
      const decoded = decodeURIComponent(encoded);
      if (!decoded) return null;
      return /^[0-9a-f]{32}$/i.test(decoded) ? `memo_${decoded}` : decoded;
    } catch {
      return null;
    }
  }

  try {
    const url = new URL(trimmed);
    if (url.origin === "https://edgeever.ai" && !url.search && !url.hash) {
      return /^\/memo\/(memo_[0-9a-f]{32})\/?$/i.exec(url.pathname)?.[1] ?? null;
    }
  } catch {
    // Non-URL hrefs that are not #memo= are ignored.
  }
  return null;
};

/**
 * Strips fenced code blocks and inline code spans in a single linear pass
 * so code snippets never emit false WikiLinks, #memo= links, or #tags.
 */
export const stripCodeRegions = (markdown: string): string => {
  if (!markdown) return "";
  const lines = markdown.split(/\r?\n/);
  const keptLines: string[] = [];
  let activeFenceChar: "`" | "~" | null = null;
  let activeFenceLength = 0;

  for (const line of lines) {
    const fenceMatch = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const fenceChar = marker[0] as "`" | "~";
      const rest = fenceMatch[2] ?? "";
      if (!activeFenceChar) {
        if (fenceChar === "`" && rest.includes("`")) {
          keptLines.push(stripInlineCodeSpans(line));
        } else {
          activeFenceChar = fenceChar;
          activeFenceLength = marker.length;
          keptLines.push("");
        }
        continue;
      }
      if (fenceChar === activeFenceChar && marker.length >= activeFenceLength && !rest.trim()) {
        activeFenceChar = null;
        activeFenceLength = 0;
        keptLines.push("");
        continue;
      }
    }
    if (activeFenceChar) {
      keptLines.push("");
      continue;
    }
    keptLines.push(stripInlineCodeSpans(line));
  }

  return keptLines.join("\n");
};

const stripInlineCodeSpans = (line: string): string => {
  if (!line.includes("`")) return line;
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\\" && index + 1 < line.length) {
      result += line.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (line[index] !== "`") {
      result += line[index];
      index += 1;
      continue;
    }
    let tickCount = 0;
    while (index + tickCount < line.length && line[index + tickCount] === "`") {
      tickCount += 1;
    }
    const closer = "`".repeat(tickCount);
    const closeIndex = line.indexOf(closer, index + tickCount);
    if (closeIndex === -1) {
      result += closer;
      index += tickCount;
      continue;
    }
    let end = closeIndex + tickCount;
    while (end < line.length && line[end] === "`") end += 1;
    if (end - closeIndex === tickCount) {
      result += " ";
      index = end;
    } else {
      result += closer;
      index += tickCount;
    }
  }
  return result;
};

interface AstWalkNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  content?: AstWalkNode[];
}

const collectAstMemoLinks = (contentJson: unknown, addMemoLink: (targetId: string, label: string) => void) => {
  if (!contentJson || typeof contentJson !== "object") return;
  const stack: AstWalkNode[] = [contentJson as AstWalkNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.type === "codeBlock") continue;
    const isInlineCode = node.marks?.some((mark) => mark.type === "code");
    if (!isInlineCode) {
      const attrHrefId = parseInternalMemoHref(node.attrs?.href);
      if (attrHrefId) addMemoLink(attrHrefId, typeof node.text === "string" ? node.text : "");
      if (Array.isArray(node.marks)) {
        for (const mark of node.marks) {
          const markHrefId = parseInternalMemoHref(mark.attrs?.href);
          if (markHrefId) addMemoLink(markHrefId, typeof node.text === "string" ? node.text : "");
        }
      }
    }
    if (Array.isArray(node.content)) {
      for (let i = node.content.length - 1; i >= 0; i -= 1) {
        stack.push(node.content[i]!);
      }
    }
  }
};

export const extractNoteOutgoingRefs = (input: {
  id: string;
  contentJson?: unknown;
  contentMarkdown: string;
  tags?: string[];
  preferMarkdownOnly?: boolean;
}): ExtractedNoteRef => {
  const memoMap = new Map<string, MemoLinkRef>();
  const wikiMap = new Map<string, WikiLinkRef>();
  const inlineTagSet = new Map<string, string>();

  const addMemoLink = (targetId: string, label: string) => {
    const normalizedId = targetId.trim();
    if (!normalizedId || normalizedId === input.id) return;
    const cleanLabel = label.trim();
    const existing = memoMap.get(normalizedId);
    if (!existing) {
      memoMap.set(normalizedId, { targetId: normalizedId, label: cleanLabel });
    } else if (!existing.label && cleanLabel) {
      existing.label = cleanLabel;
    }
  };

  if (!input.preferMarkdownOnly && input.contentJson) {
    collectAstMemoLinks(input.contentJson, addMemoLink);
  }

  const sanitized = stripCodeRegions(input.contentMarkdown ?? "");

  // Extract Markdown links [label](href) referencing #memo=... or edgeever.ai/memo/...
  const mdLinkPattern = /\[([^\]\r\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of sanitized.matchAll(mdLinkPattern)) {
    const index = match.index ?? 0;
    if (index > 0 && sanitized[index - 1] === "\\") continue;
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    const targetId = parseInternalMemoHref(href);
    if (targetId) addMemoLink(targetId, label);
  }

  // Extract bare #memo=... tokens (e.g. inside structured note payloads or raw links)
  const bareMemoPattern = /(?:^|[\s(<"'])((?:https?:\/\/[^\s)>'"]*)?#memo=[A-Za-z0-9_%-]+)/g;
  for (const match of sanitized.matchAll(bareMemoPattern)) {
    const targetId = parseInternalMemoHref(match[1]);
    if (targetId) addMemoLink(targetId, "");
  }

  // Extract non-embed WikiLinks [[target|alias]] / [[target#heading]]
  const wikiPattern = /\[\[([^[\]\r\n]+)\]\]/g;
  for (const match of sanitized.matchAll(wikiPattern)) {
    const index = match.index ?? 0;
    if (index > 0 && (sanitized[index - 1] === "!" || sanitized[index - 1] === "\\")) continue;
    const rawInner = (match[1] ?? "").trim();
    if (!rawInner) continue;
    const pipeIndex = rawInner.indexOf("|");
    const targetSegment = (pipeIndex >= 0 ? rawInner.slice(0, pipeIndex) : rawInner).trim();
    const alias = (pipeIndex >= 0 ? rawInner.slice(pipeIndex + 1) : "").trim();
    const target = targetSegment.split("#")[0]!.split("^")[0]!.trim();
    if (!target) continue;
    const key = target.toLocaleLowerCase();
    const existing = wikiMap.get(key);
    if (!existing) {
      wikiMap.set(key, { target, alias });
    } else if (!existing.alias && alias) {
      existing.alias = alias;
    }
  }

  // Strip Markdown links and WikiLinks before scanning inline #tags so URLs/headings don't leak as tags
  const withoutLinks = sanitized
    .replace(/\[([^\]\r\n]*)\]\(([^)\r\n]*)\)/g, " ")
    .replace(/\[\[([^[\]\r\n]+)\]\]/g, " ")
    .replace(/^[ ]{0,3}#{1,6}[ \t]+/gm, " ");

  const inlineTagPattern = /(?:^|[\s(>])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,63})/gu;
  for (const match of withoutLinks.matchAll(inlineTagPattern)) {
    const tag = (match[1] ?? "").replace(/\/+$/, "").trim();
    if (!tag || /^\d+$/.test(tag)) continue;
    const lower = tag.toLocaleLowerCase();
    if (!inlineTagSet.has(lower)) inlineTagSet.set(lower, tag);
  }

  return {
    memoLinks: [...memoMap.values()],
    wikiLinks: [...wikiMap.values()],
    inlineTags: [...inlineTagSet.values()],
  };
};
