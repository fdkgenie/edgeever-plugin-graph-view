import type { GraphNode } from "./types";

interface QueryTerm {
  negated: boolean;
  operator: "tag" | "path" | "file" | "kind" | "is" | "text";
  value: string;
}

export type CompiledGraphQuery = (node: GraphNode) => boolean;

type Token =
  | { kind: "lparen"; negated: boolean }
  | { kind: "rparen" }
  | { kind: "or" }
  | { kind: "word"; value: string };

const tokenizeQuery = (raw: string): Token[] => {
  const tokens: Token[] = [];
  let current = "";
  let quoteChar: '"' | "'" | null = null;

  const flushCurrent = () => {
    if (!current) return;
    if (current === "OR") {
      tokens.push({ kind: "or" });
    } else {
      tokens.push({ kind: "word", value: current });
    }
    current = "";
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quoteChar) {
      if (ch === quoteChar) {
        quoteChar = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      continue;
    }
    if (ch === "(") {
      if (current === "-") {
        current = "";
        tokens.push({ kind: "lparen", negated: true });
      } else {
        flushCurrent();
        tokens.push({ kind: "lparen", negated: false });
      }
      continue;
    }
    if (ch === ")") {
      flushCurrent();
      tokens.push({ kind: "rparen" });
      continue;
    }
    if (/\s/.test(ch)) {
      flushCurrent();
      continue;
    }
    current += ch;
  }

  flushCurrent();
  return tokens;
};

const parseTerm = (rawToken: string): QueryTerm | null => {
  let token = rawToken.trim();
  if (!token) return null;

  let negated = false;
  if (token.startsWith("-") && token.length > 1) {
    negated = true;
    token = token.slice(1);
  }

  const colonIndex = token.indexOf(":");
  if (colonIndex > 0) {
    const prefix = token.slice(0, colonIndex).toLocaleLowerCase();
    const rawValue = token.slice(colonIndex + 1).trim();
    const value = rawValue.toLocaleLowerCase();
    if (!value) return null;

    if (prefix === "tag") {
      return { negated, operator: "tag", value: value.replace(/^#/, "") };
    }
    if (prefix === "path" || prefix === "notebook" || prefix === "folder") {
      return { negated, operator: "path", value };
    }
    if (prefix === "file" || prefix === "title") {
      return { negated, operator: "file", value };
    }
    if (prefix === "kind" || prefix === "type") {
      return { negated, operator: "kind", value };
    }
    if (prefix === "is") {
      return { negated, operator: "is", value };
    }
  }

  if (token.startsWith("#") && token.length > 1) {
    return { negated, operator: "tag", value: token.slice(1).toLocaleLowerCase() };
  }

  return { negated, operator: "text", value: token.toLocaleLowerCase() };
};

const matchTerm = (node: GraphNode, term: QueryTerm): boolean => {
  const { operator, value } = term;
  if (operator === "tag") {
    const tags = node.tags.map((tag) => tag.toLocaleLowerCase().replace(/^#/, ""));
    if (node.nodeType === "tag") {
      const own = node.label.toLocaleLowerCase().replace(/^#/, "");
      return own === value || own.startsWith(`${value}/`) || own.includes(value);
    }
    return tags.some((tag) => tag === value || tag.startsWith(`${value}/`) || tag.includes(value));
  }

  if (operator === "path") {
    const path = (node.notebookPath ?? "").toLocaleLowerCase();
    return path.includes(value);
  }

  if (operator === "file") {
    return node.label.toLocaleLowerCase().includes(value);
  }

  if (operator === "kind") {
    const kind = (node.noteKind ?? node.nodeType).toLocaleLowerCase();
    return kind === value || node.nodeType.toLocaleLowerCase() === value;
  }

  if (operator === "is") {
    if (value === "pinned") return node.isPinned;
    if (value === "orphan") return node.degree === 0;
    if (value === "unresolved") return node.nodeType === "unresolved";
    if (value === "tag") return node.nodeType === "tag";
    if (value === "attachment") return node.nodeType === "attachment";
    if (value === "note") return node.nodeType === "note";
    return false;
  }

  const haystack = [
    node.label,
    node.notebookPath ?? "",
    node.tags.join(" "),
    node.excerpt,
    node.rawId,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return haystack.includes(value);
};

export const compileGraphQuery = (raw: string): CompiledGraphQuery | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tokens = tokenizeQuery(trimmed);
  if (!tokens.length) return null;

  let cursor = 0;

  const parseOr = (): CompiledGraphQuery | null => {
    const branches: CompiledGraphQuery[] = [];
    const first = parseAnd();
    if (first) branches.push(first);
    while (cursor < tokens.length && tokens[cursor]?.kind === "or") {
      cursor += 1;
      const next = parseAnd();
      if (next) branches.push(next);
    }
    if (!branches.length) return null;
    if (branches.length === 1) return branches[0]!;
    return (node) => branches.some((branch) => branch(node));
  };

  const parseAnd = (): CompiledGraphQuery | null => {
    const clauses: CompiledGraphQuery[] = [];
    while (cursor < tokens.length) {
      const peek = tokens[cursor]!;
      if (peek.kind === "or" || peek.kind === "rparen") break;
      const atom = parseAtom();
      if (atom) clauses.push(atom);
    }
    if (!clauses.length) return null;
    if (clauses.length === 1) return clauses[0]!;
    return (node) => clauses.every((clause) => clause(node));
  };

  const parseAtom = (): CompiledGraphQuery | null => {
    const token = tokens[cursor];
    if (!token) return null;

    if (token.kind === "lparen") {
      cursor += 1;
      const inner = parseOr();
      if (tokens[cursor]?.kind === "rparen") cursor += 1;
      if (!inner) return null;
      return token.negated ? (node) => !inner(node) : inner;
    }

    if (token.kind === "word") {
      cursor += 1;
      const term = parseTerm(token.value);
      if (!term) return null;
      return (node) => {
        const matched = matchTerm(node, term);
        return term.negated ? !matched : matched;
      };
    }

    cursor += 1;
    return null;
  };

  return parseOr();
};

export const matchesExcludedPatterns = (node: GraphNode, rawPatterns: string): boolean => {
  const trimmed = rawPatterns.trim();
  if (!trimmed) return false;
  const parts = trimmed
    .split(/[,\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const matcher = compileGraphQuery(part);
    if (matcher && matcher(node)) return true;
  }
  return false;
};
