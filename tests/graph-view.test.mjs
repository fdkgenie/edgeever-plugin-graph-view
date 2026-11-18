import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraphData } from "../src/graph-builder.ts";
import { ForceSimulation } from "../src/force-simulation.ts";
import { GraphWorkspaceIndexer } from "../src/graph-indexer.ts";
import plugin from "../src/index.ts";
import { extractNoteOutgoingRefs, parseInternalMemoHref, stripCodeRegions } from "../src/link-extractor.ts";
import { compileGraphQuery } from "../src/query-engine.ts";
import {
  DEFAULT_GRAPH_DISPLAY,
  DEFAULT_GRAPH_FILTERS,
  DEFAULT_GRAPH_FORCES,
} from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const makeNote = (overrides) => ({
  id: "note-1",
  notebookId: "nb-1",
  title: "Note One",
  excerpt: "Summary",
  kind: "text",
  tags: [],
  inlineTags: [],
  isPinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  memoLinks: [],
  wikiLinks: [],
  ...overrides,
});

const baseState = (overrides = {}) => ({
  mode: "global",
  focusNoteId: null,
  localDepth: 1,
  localDirection: "both",
  maxNotes: 1000,
  filters: { ...DEFAULT_GRAPH_FILTERS },
  groups: [],
  display: { ...DEFAULT_GRAPH_DISPLAY },
  forces: { ...DEFAULT_GRAPH_FORCES },
  ...overrides,
});

describe("manifest & plugin entry", () => {
  test("manifest declares valid Plugin API v2 fields and root entry", async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, "manifest.json"), "utf8"));
    expect(manifest.type).toBe("plugin");
    expect(manifest.id).toBe("io.github.fdkgenie.graph-view");
    expect(manifest.apiVersion).toBe("2");
    expect(manifest.settingsUi).toBe("host");
    expect(manifest.entry).toBe("./main.js");
  });

  test("activate registers Global/Local commands and fullscreen dashboard panel cleanly", async () => {
    const commands = [];
    const panels = [];
    const openedPanels = [];
    const notices = [];
    const fakeContext = {
      pluginId: "io.github.fdkgenie.graph-view",
      notes: { query: async () => ({ notes: [], totalCount: 0, nextOffset: null }), get: async () => null },
      notebooks: { list: async () => [] },
      commands: {
        register: (cmd) => {
          commands.push(cmd);
          return () => undefined;
        },
      },
      events: { on: () => () => undefined },
      storage: { get: async () => null, set: async () => undefined, remove: async () => undefined },
      editor: { getDocument: async () => ({ noteId: "note-a", contentMarkdown: "", hasUnsavedChanges: false }) },
      resources: { list: async () => [] },
      settings: { get: async () => null, set: async () => undefined, remove: async () => undefined },
      ui: {
        showNotice: (msg) => notices.push(msg),
        openNote: async () => undefined,
        panels: {
          register: (panel) => {
            panels.push(panel);
            return () => undefined;
          },
          open: async (id, opts) => {
            openedPanels.push({ id, opts });
          },
        },
      },
    };

    const dispose = await plugin.activate(fakeContext);
    expect(panels.map((p) => [p.id, p.purpose, p.presentation])).toEqual([
      ["graph-view", "dashboard", "fullscreen"],
    ]);
    expect(commands.map((c) => c.id)).toEqual(["open-graph-view", "open-local-graph"]);

    await commands[1].run();
    expect(openedPanels).toEqual([{ id: "graph-view", opts: { state: { mode: "local", focusNoteId: "note-a" } } }]);
    expect(notices).toEqual([]);
    dispose?.();
  });
});

describe("link-extractor", () => {
  test("parses #memo= links, bare 32-hex IDs, and legacy assistant URLs", () => {
    expect(parseInternalMemoHref("#memo=memo_abc")).toBe("memo_abc");
    expect(parseInternalMemoHref("https://notes.local/#memo=memo%2F1")).toBe("memo/1");
    expect(parseInternalMemoHref("#memo=04833dc5c42d4286800f13be0405f099")).toBe(
      "memo_04833dc5c42d4286800f13be0405f099",
    );
    expect(parseInternalMemoHref("https://edgeever.ai/memo/memo_04833dc5c42d4286800f13be0405f099")).toBe(
      "memo_04833dc5c42d4286800f13be0405f099",
    );
    expect(parseInternalMemoHref("https://example.com/page#heading")).toBeNull();
  });

  test("strips fenced and inline code regions before extraction", () => {
    const markdown = [
      "# Real Heading",
      "Link to [Project](#memo=memo_proj) and [[Roadmap|Road]] with #active/q1.",
      "Ignore image embed ![[diagram.png]] and `[[CodeLink]] #codeTag`.",
      "```md",
      "[[FencedLink]] [Fake](#memo=memo_fake) #fencedTag",
      "```",
      "Also ignore [Self](#memo=memo_self) and [Poster Source](#memo=memo_poster_src).",
    ].join("\n");

    expect(stripCodeRegions("before `inline` after")).toBe("before   after");

    const refs = extractNoteOutgoingRefs({
      id: "memo_self",
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "AST Note",
                marks: [{ type: "link", attrs: { href: "#memo=memo_ast" } }],
              },
            ],
          },
        ],
      },
      contentMarkdown: markdown,
    });

    expect(refs.memoLinks.map((item) => item.targetId)).toEqual([
      "memo_ast",
      "memo_proj",
      "memo_poster_src",
    ]);
    expect(refs.wikiLinks).toEqual([{ target: "Roadmap", alias: "Road" }]);
    expect(refs.inlineTags).toEqual(["active/q1"]);
  });

  test("handles WikiLinks with headings, block refs, and notebook paths", () => {
    const refs = extractNoteOutgoingRefs({
      id: "memo_a",
      contentMarkdown: "See [[Work/Architecture#Auth^b1|Auth Design]] and [[Backlog]].",
    });
    expect(refs.wikiLinks).toEqual([
      { target: "Work/Architecture", alias: "Auth Design" },
      { target: "Backlog", alias: "" },
    ]);
  });
});

describe("query-engine & graph-builder", () => {
  const notebooks = [
    { id: "nb-work", parentId: null, name: "Work", memoCount: 2 },
    { id: "nb-arch", parentId: "nb-work", name: "Architecture", memoCount: 1 },
    { id: "nb-personal", parentId: null, name: "Personal", memoCount: 1 },
  ];

  const notes = [
    makeNote({
      id: "a",
      notebookId: "nb-work",
      title: "Alpha Hub",
      tags: ["project", "work/core"],
      isPinned: true,
      memoLinks: [{ targetId: "b", label: "Beta" }],
      wikiLinks: [{ target: "Work/Architecture/Gamma", alias: "" }, { target: "Future Note", alias: "" }],
    }),
    makeNote({
      id: "b",
      notebookId: "nb-personal",
      title: "Beta",
      kind: "poster",
      tags: ["design"],
      memoLinks: [{ targetId: "c", label: "Gamma" }],
    }),
    makeNote({
      id: "c",
      notebookId: "nb-arch",
      title: "Gamma",
      tags: ["draft"],
    }),
    makeNote({
      id: "d",
      notebookId: "nb-personal",
      title: "Lonely Note",
      tags: ["journal"],
    }),
  ];

  const attachments = [
    {
      id: "att-1",
      noteId: "b",
      kind: "image",
      filename: "poster-cover.png",
      mimeType: "image/png",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      url: "/api/v1/resources/att-1/blob",
    },
  ];

  test("builds Global graph with tags, attachments, unresolved nodes, orphans, exclusions, and color groups", () => {
    const graph = buildGraphData({
      notes,
      notebooks,
      attachments,
      untitledLabel: "Untitled",
      state: baseState({
        filters: {
          search: "",
          showTags: true,
          showAttachments: true,
          existingFilesOnly: false,
          showOrphans: false,
          excludedPatterns: "tag:#draft",
        },
        groups: [
          { id: "g1", query: "is:pinned", color: "#2563eb", enabled: true },
          { id: "g2", query: "kind:poster OR path:Personal", color: "#db2777", enabled: true },
        ],
      }),
    });

    expect(graph.nodeById.has("note:c")).toBe(false);
    expect(graph.nodeById.has("note:a")).toBe(true);
    expect(graph.nodeById.has("note:b")).toBe(true);
    expect(graph.nodeById.has("unresolved:wiki:future note")).toBe(true);
    expect(graph.nodeById.has("tag:project")).toBe(true);
    expect(graph.nodeById.has("attachment:att-1")).toBe(true);
    expect(graph.nodeById.get("note:a")?.groupColor).toBe("#2563eb");
    expect(graph.nodeById.get("note:b")?.groupColor).toBe("#db2777");
  });

  test("builds Local graph respecting BFS depth and link direction", () => {
    const depth1 = buildGraphData({
      notes,
      notebooks,
      attachments,
      untitledLabel: "Untitled",
      state: baseState({
        mode: "local",
        focusNoteId: "a",
        localDepth: 1,
        localDirection: "outgoing",
        filters: { ...DEFAULT_GRAPH_FILTERS, existingFilesOnly: true },
      }),
    });
    expect(depth1.nodes.map((n) => n.rawId).sort()).toEqual(["a", "b", "c"]);

    const incomingToB = buildGraphData({
      notes,
      notebooks,
      attachments,
      untitledLabel: "Untitled",
      state: baseState({
        mode: "local",
        focusNoteId: "b",
        localDepth: 1,
        localDirection: "incoming",
        filters: { ...DEFAULT_GRAPH_FILTERS, existingFilesOnly: true },
      }),
    });
    expect(incomingToB.nodes.map((n) => n.rawId).sort()).toEqual(["a", "b"]);
  });

  test("evaluates search queries with quoted terms, parentheses, negation, OR, and operators", () => {
    const graph = buildGraphData({
      notes,
      notebooks,
      attachments,
      untitledLabel: "Untitled",
      state: baseState(),
    });
    const matcher = compileGraphQuery('"Alpha Hub" OR (kind:poster -tag:#draft)');
    expect(matcher).not.toBeNull();
    expect(matcher(graph.nodeById.get("note:a"))).toBe(true);
    expect(matcher(graph.nodeById.get("note:b"))).toBe(true);
    expect(matcher(graph.nodeById.get("note:c"))).toBe(false);
  });
});

describe("ForceSimulation", () => {
  test("converges cleanly for Barnes-Hut (>80 nodes) graphs and respects pinned nodes", () => {
    const nodes = Array.from({ length: 120 }, (_, i) => ({
      id: `note:n${i}`,
      rawId: `n${i}`,
      nodeType: "note",
      label: `N${i}`,
      tags: [],
      excerpt: "",
      isPinned: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      inDegree: 1,
      outDegree: 1,
      degree: 2,
      radius: 6,
    }));
    const edges = nodes.slice(1).map((node, i) => ({
      id: `e${i}`,
      source: `note:n${Math.floor(i / 2)}`,
      target: node.id,
      kind: "link",
    }));

    const sim = new ForceSimulation(DEFAULT_GRAPH_FORCES);
    sim.setGraph(nodes, edges);
    sim.pinNode("note:n0", 12, -18);
    sim.tick(260);

    const pinned = sim.nodeMap.get("note:n0");
    expect(pinned.x).toBe(12);
    expect(pinned.y).toBe(-18);
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    expect(sim.isSettled()).toBe(true);
  });
});

describe("GraphWorkspaceIndexer read budget & incremental updates", () => {
  test("paginates notes.query, performs 0 notes.get on warm cache, and updates incrementally on events", async () => {
    const store = new Map();
    const eventHandlers = new Map();
    let getCalls = 0;
    let queryCalls = 0;

    const total = 250;
    const dbNotes = new Map();
    for (let i = 0; i < total; i += 1) {
      const id = `m_${String(i).padStart(3, "0")}`;
      dbNotes.set(id, {
        id,
        notebookId: "nb-1",
        title: `Memo ${i}`,
        excerpt: "",
        kind: "text",
        tags: ["bulk"],
        isPinned: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: `2026-01-02T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        contentJson: { type: "doc", content: [] },
        revision: 1,
        contentMarkdown: i === 0 ? "Links [[Memo 1]]" : "Body",
        contentText: "",
        contentHash: `h_${i}`,
      });
    }

    const fakeContext = {
      notebooks: {
        list: async () => [{ id: "nb-1", parentId: null, name: "Root", memoCount: total }],
      },
      notes: {
        query: async ({ limit = 50, offset = 0 } = {}) => {
          queryCalls += 1;
          const all = [...dbNotes.values()];
          const slice = all.slice(offset, offset + limit);
          return {
            notes: slice,
            totalCount: all.length,
            nextOffset: offset + slice.length < all.length ? offset + slice.length : null,
          };
        },
        get: async (id) => {
          getCalls += 1;
          return dbNotes.get(id);
        },
      },
      editor: { getDocument: async () => null },
      resources: { list: async () => [] },
      storage: {
        get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
        set: async (key, value) => {
          store.set(key, JSON.stringify(value));
        },
      },
      events: {
        on: (event, cb) => {
          const set = eventHandlers.get(event) ?? new Set();
          set.add(cb);
          eventHandlers.set(event, set);
          return () => set.delete(cb);
        },
      },
    };

    const firstIndexer = new GraphWorkspaceIndexer(fakeContext);
    await firstIndexer.syncIndex({ maxNotes: 1000, includeAttachments: false });
    expect(queryCalls).toBe(2);
    expect(getCalls).toBe(250);

    getCalls = 0;
    queryCalls = 0;
    const warmIndexer = new GraphWorkspaceIndexer(fakeContext);
    await warmIndexer.syncIndex({ maxNotes: 1000, includeAttachments: false });
    expect(queryCalls).toBe(2);
    expect(getCalls).toBe(0);

    getCalls = 0;
    queryCalls = 0;
    const dispose = warmIndexer.subscribeWorkspaceEvents();
    for (const cb of eventHandlers.get("note.updated") ?? []) {
      cb({
        note: {
          ...dbNotes.get("m_001"),
          updatedAt: "2026-02-01T00:00:00.000Z",
          contentMarkdown: "Updated [[Memo 2]]",
        },
      });
    }
    expect(queryCalls).toBe(0);
    expect(getCalls).toBe(0);
    expect(warmIndexer.getSnapshot().notes.find((n) => n.id === "m_001")?.wikiLinks).toEqual([
      { target: "Memo 2", alias: "" },
    ]);
    dispose();
  });
});
