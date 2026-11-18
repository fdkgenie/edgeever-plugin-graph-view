import type { PluginNotebook } from "./plugin-api-types";
import { compileGraphQuery, matchesExcludedPatterns } from "./query-engine";
import type {
  GraphColorGroup,
  GraphData,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphViewState,
  IndexedAttachmentRecord,
  IndexedNoteRecord,
} from "./types";

export interface BuildGraphInput {
  notes: readonly IndexedNoteRecord[];
  notebooks: readonly PluginNotebook[];
  attachments: readonly IndexedAttachmentRecord[];
  state: GraphViewState;
  untitledLabel: string;
}

export const buildNotebookPaths = (notebooks: readonly PluginNotebook[]): Map<string, string> => {
  const byId = new Map<string, PluginNotebook>(notebooks.map((notebook) => [notebook.id, notebook]));
  const cache = new Map<string, string>();

  const resolve = (notebookId: string): string => {
    const existing = cache.get(notebookId);
    if (existing !== undefined) return existing;
    const parts: string[] = [];
    const seen = new Set<string>();
    let currentId: string | null = notebookId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const nb = byId.get(currentId);
      if (!nb) break;
      parts.unshift(nb.name);
      currentId = nb.parentId;
    }
    const path = parts.join("/");
    cache.set(notebookId, path);
    return path;
  };

  for (const nb of notebooks) resolve(nb.id);
  return cache;
};

const normalizeWikiKey = (value: string) => value.trim().replace(/^\/+|\/+$/g, "").toLocaleLowerCase();

export const noteNodeId = (noteId: string) => `note:${noteId}`;
export const unresolvedNodeId = (key: string) => `unresolved:${key}`;
export const tagNodeId = (tag: string) => `tag:${tag.toLocaleLowerCase()}`;
export const attachmentNodeId = (resourceId: string) => `attachment:${resourceId}`;

export const buildGraphData = ({
  notes,
  notebooks,
  attachments,
  state,
  untitledLabel,
}: BuildGraphInput): GraphData => {
  const notebookPaths = buildNotebookPaths(notebooks);
  const notesById = new Map<string, IndexedNoteRecord>();
  const pathTitleIndex = new Map<string, IndexedNoteRecord[]>();
  const titleIndex = new Map<string, IndexedNoteRecord[]>();

  const sortedNotes = [...notes].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const note of sortedNotes) {
    notesById.set(note.id, note);
    const title = (note.title ?? "").trim();
    if (!title) continue;
    const titleKey = title.toLocaleLowerCase();
    const titleBucket = titleIndex.get(titleKey) ?? [];
    titleBucket.push(note);
    titleIndex.set(titleKey, titleBucket);

    const nbPath = notebookPaths.get(note.notebookId);
    if (nbPath) {
      const fullKey = `${nbPath.toLocaleLowerCase()}/${titleKey}`;
      const pathBucket = pathTitleIndex.get(fullKey) ?? [];
      pathBucket.push(note);
      pathTitleIndex.set(fullKey, pathBucket);
    }
  }

  const resolveWikiTarget = (rawTarget: string, sourceNotebookId: string): IndexedNoteRecord | null => {
    const normalized = normalizeWikiKey(rawTarget);
    if (!normalized) return null;
    if (notesById.has(rawTarget.trim())) return notesById.get(rawTarget.trim())!;

    const byFullPath = pathTitleIndex.get(normalized);
    if (byFullPath?.length) return byFullPath[0]!;

    const byTitle = titleIndex.get(normalized);
    if (byTitle?.length) {
      const sameNotebook = byTitle.find((candidate) => candidate.notebookId === sourceNotebookId);
      return sameNotebook ?? byTitle[0]!;
    }

    const basename = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : "";
    if (basename) {
      const byBase = titleIndex.get(basename);
      if (byBase?.length) return byBase[0]!;
    }

    return null;
  };

  const rawNodes = new Map<string, GraphNode>();
  const rawEdges = new Map<string, GraphEdge>();

  const ensureEdge = (source: string, target: string, kind: GraphEdgeKind, label?: string) => {
    if (source === target) return;
    const edgeKey = `${source}->${target}:${kind}`;
    if (!rawEdges.has(edgeKey)) {
      rawEdges.set(edgeKey, {
        id: edgeKey,
        source,
        target,
        kind,
        ...(label ? { label } : {}),
      });
    }
  };

  for (const note of sortedNotes) {
    const mergedTags = new Map<string, string>();
    for (const tag of [...note.tags, ...note.inlineTags]) {
      const cleaned = tag.trim().replace(/^#/, "");
      if (!cleaned) continue;
      const lower = cleaned.toLocaleLowerCase();
      if (!mergedTags.has(lower)) mergedTags.set(lower, cleaned);
    }
    const label = note.title?.trim() || note.excerpt?.trim() || untitledLabel;
    const id = noteNodeId(note.id);
    rawNodes.set(id, {
      id,
      rawId: note.id,
      nodeType: "note",
      label,
      noteKind: note.kind,
      notebookId: note.notebookId,
      notebookPath: notebookPaths.get(note.notebookId) ?? "",
      tags: [...mergedTags.values()],
      excerpt: note.excerpt ?? "",
      isPinned: note.isPinned,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      inDegree: 0,
      outDegree: 0,
      degree: 0,
      radius: 5,
    });
  }

  for (const note of sortedNotes) {
    const sourceId = noteNodeId(note.id);
    const sourceNode = rawNodes.get(sourceId);
    if (!sourceNode) continue;

    for (const ref of note.memoLinks) {
      if (notesById.has(ref.targetId)) {
        ensureEdge(sourceId, noteNodeId(ref.targetId), "link", ref.label);
      } else if (!state.filters.existingFilesOnly) {
        const phantomId = unresolvedNodeId(`memo:${ref.targetId}`);
        if (!rawNodes.has(phantomId)) {
          rawNodes.set(phantomId, {
            id: phantomId,
            rawId: ref.targetId,
            nodeType: "unresolved",
            label: ref.label || ref.targetId,
            tags: [],
            excerpt: "",
            isPinned: false,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            inDegree: 0,
            outDegree: 0,
            degree: 0,
            radius: 4,
          });
        }
        ensureEdge(sourceId, phantomId, "unresolved", ref.label);
      }
    }

    for (const wiki of note.wikiLinks) {
      const resolved = resolveWikiTarget(wiki.target, note.notebookId);
      if (resolved) {
        ensureEdge(sourceId, noteNodeId(resolved.id), "link", wiki.alias || wiki.target);
      } else if (!state.filters.existingFilesOnly) {
        const key = `wiki:${normalizeWikiKey(wiki.target)}`;
        const phantomId = unresolvedNodeId(key);
        if (!rawNodes.has(phantomId)) {
          rawNodes.set(phantomId, {
            id: phantomId,
            rawId: wiki.target,
            nodeType: "unresolved",
            label: wiki.target,
            tags: [],
            excerpt: "",
            isPinned: false,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            inDegree: 0,
            outDegree: 0,
            degree: 0,
            radius: 4,
          });
        }
        ensureEdge(sourceId, phantomId, "unresolved", wiki.alias || wiki.target);
      }
    }

    if (state.filters.showTags) {
      for (const tag of sourceNode.tags) {
        const tId = tagNodeId(tag);
        if (!rawNodes.has(tId)) {
          rawNodes.set(tId, {
            id: tId,
            rawId: tag,
            nodeType: "tag",
            label: `#${tag}`,
            tags: [tag],
            excerpt: "",
            isPinned: false,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            inDegree: 0,
            outDegree: 0,
            degree: 0,
            radius: 4,
          });
        }
        ensureEdge(sourceId, tId, "tag");
      }
    }
  }

  if (state.filters.showAttachments) {
    for (const resource of attachments) {
      const parentId = noteNodeId(resource.noteId);
      if (!rawNodes.has(parentId)) continue;
      const attId = attachmentNodeId(resource.id);
      if (!rawNodes.has(attId)) {
        rawNodes.set(attId, {
          id: attId,
          rawId: resource.id,
          nodeType: "attachment",
          label: resource.filename?.trim() || resource.kind,
          tags: [],
          excerpt: resource.mimeType ?? "",
          isPinned: false,
          createdAt: resource.createdAt,
          updatedAt: resource.updatedAt,
          inDegree: 0,
          outDegree: 0,
          degree: 0,
          radius: 4,
          url: resource.url,
        });
      }
      ensureEdge(parentId, attId, "attachment");
    }
  }

  // First degree pass so excludedPatterns / query rules like `is:orphan` evaluate accurately
  computeDegrees(rawNodes, [...rawEdges.values()]);

  // Exclude patterns filter
  if (state.filters.excludedPatterns.trim()) {
    for (const [id, node] of rawNodes) {
      if (matchesExcludedPatterns(node, state.filters.excludedPatterns)) {
        rawNodes.delete(id);
      }
    }
  }

  let survivingEdges = [...rawEdges.values()].filter(
    (edge) => rawNodes.has(edge.source) && rawNodes.has(edge.target),
  );
  computeDegrees(rawNodes, survivingEdges);

  // Local graph BFS neighborhood slice
  let activeFocusNoteId: string | null = null;
  if (state.mode === "local") {
    const focusKey = state.focusNoteId ? noteNodeId(state.focusNoteId) : null;
    if (focusKey && rawNodes.has(focusKey)) {
      activeFocusNoteId = state.focusNoteId;
      const depthLimit = Math.min(Math.max(Math.round(state.localDepth || 1), 1), 5);
      const hopById = collectLocalNeighborhood(
        focusKey,
        survivingEdges,
        depthLimit,
        state.localDirection,
      );
      for (const [id, node] of rawNodes) {
        const hop = hopById.get(id);
        if (hop === undefined) {
          rawNodes.delete(id);
        } else {
          node.hopDistance = hop;
        }
      }
      survivingEdges = survivingEdges.filter(
        (edge) => rawNodes.has(edge.source) && rawNodes.has(edge.target),
      );
      computeDegrees(rawNodes, survivingEdges);
    } else {
      rawNodes.clear();
      survivingEdges = [];
    }
  }

  // Search query filter
  const searchMatcher = compileGraphQuery(state.filters.search);
  if (searchMatcher) {
    for (const [id, node] of rawNodes) {
      if (state.mode === "local" && node.hopDistance === 0) continue;
      if (!searchMatcher(node)) rawNodes.delete(id);
    }
    survivingEdges = survivingEdges.filter(
      (edge) => rawNodes.has(edge.source) && rawNodes.has(edge.target),
    );
    computeDegrees(rawNodes, survivingEdges);
  }

  // Orphans filter
  if (!state.filters.showOrphans) {
    for (const [id, node] of rawNodes) {
      if (state.mode === "local" && node.hopDistance === 0) continue;
      if (node.degree === 0) rawNodes.delete(id);
    }
    survivingEdges = survivingEdges.filter(
      (edge) => rawNodes.has(edge.source) && rawNodes.has(edge.target),
    );
    computeDegrees(rawNodes, survivingEdges);
  }

  // Radius & Group colors
  const compiledGroups = compileColorGroups(state.groups);
  const scale = Math.min(Math.max(state.display.nodeSize, 0.4), 3);

  const neighborsById = new Map<string, Set<string>>();
  for (const node of rawNodes.values()) {
    neighborsById.set(node.id, new Set());
    const baseRadius = node.nodeType === "note" ? 5.2 : node.nodeType === "tag" ? 4.4 : 4.0;
    const weightedDegree = node.inDegree * 1.2 + node.outDegree * 0.55;
    node.radius = Math.min(28, baseRadius * scale * (1 + Math.log1p(weightedDegree) * 0.45));

    for (const group of compiledGroups) {
      if (group.match(node)) {
        node.groupId = group.id;
        node.groupColor = group.color;
        break;
      }
    }
  }

  for (const edge of survivingEdges) {
    neighborsById.get(edge.source)?.add(edge.target);
    neighborsById.get(edge.target)?.add(edge.source);
  }

  return {
    nodes: [...rawNodes.values()],
    edges: survivingEdges,
    nodeById: rawNodes,
    neighborsById,
    totalIndexedNotes: notes.length,
    activeFocusNoteId,
  };
};

const computeDegrees = (nodes: Map<string, GraphNode>, edges: readonly GraphEdge[]) => {
  for (const node of nodes.values()) {
    node.inDegree = 0;
    node.outDegree = 0;
    node.degree = 0;
  }
  for (const edge of edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) continue;
    source.outDegree += 1;
    source.degree += 1;
    target.inDegree += 1;
    target.degree += 1;
  }
};

const collectLocalNeighborhood = (
  focusId: string,
  edges: readonly GraphEdge[],
  depthLimit: number,
  direction: GraphViewState["localDirection"],
): Map<string, number> => {
  const adjacency = new Map<string, string[]>();
  const addAdj = (from: string, to: string) => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };

  for (const edge of edges) {
    if (direction === "both" || direction === "outgoing") {
      addAdj(edge.source, edge.target);
    }
    if (direction === "both" || direction === "incoming") {
      addAdj(edge.target, edge.source);
    }
  }

  const visited = new Map<string, number>([[focusId, 0]]);
  const queue: Array<[string, number]> = [[focusId, 0]];
  let head = 0;

  while (head < queue.length) {
    const [currentId, dist] = queue[head++]!;
    if (dist >= depthLimit) continue;
    for (const nextId of adjacency.get(currentId) ?? []) {
      if (!visited.has(nextId)) {
        visited.set(nextId, dist + 1);
        queue.push([nextId, dist + 1]);
      }
    }
  }

  return visited;
};

const compileColorGroups = (groups: readonly GraphColorGroup[]) => {
  const result: Array<{ id: string; color: string; match: (node: GraphNode) => boolean }> = [];
  for (const group of groups) {
    if (!group.enabled || !group.query.trim()) continue;
    const matcher = compileGraphQuery(group.query);
    if (matcher) {
      result.push({ id: group.id, color: group.color, match: matcher });
    }
  }
  return result;
};
