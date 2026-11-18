import type { PluginNoteKind, PluginResource } from "./plugin-api-types";

export type GraphMode = "global" | "local";
export type LocalLinkDirection = "both" | "outgoing" | "incoming";
export type GraphNodeType = "note" | "unresolved" | "tag" | "attachment";
export type GraphEdgeKind = "link" | "unresolved" | "tag" | "attachment";

export interface GraphColorGroup {
  id: string;
  query: string;
  color: string;
  enabled: boolean;
}

export interface GraphFiltersState {
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  existingFilesOnly: boolean;
  showOrphans: boolean;
  excludedPatterns: string;
}

export interface GraphDisplayState {
  showArrows: boolean;
  textFadeThreshold: number;
  nodeSize: number;
  linkThickness: number;
}

export interface GraphForcesState {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

export interface GraphViewState {
  mode: GraphMode;
  focusNoteId: string | null;
  localDepth: number;
  localDirection: LocalLinkDirection;
  maxNotes: number;
  filters: GraphFiltersState;
  groups: GraphColorGroup[];
  display: GraphDisplayState;
  forces: GraphForcesState;
}

export const DEFAULT_GROUP_COLORS = [
  "#16a06e",
  "#2563eb",
  "#d97706",
  "#db2777",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#65a30d",
] as const;

export const DEFAULT_GRAPH_FILTERS: GraphFiltersState = {
  search: "",
  showTags: false,
  showAttachments: false,
  existingFilesOnly: false,
  showOrphans: true,
  excludedPatterns: "",
};

export const DEFAULT_GRAPH_DISPLAY: GraphDisplayState = {
  showArrows: false,
  textFadeThreshold: 0,
  nodeSize: 1,
  linkThickness: 1,
};

export const DEFAULT_GRAPH_FORCES: GraphForcesState = {
  centerForce: 0.45,
  repelForce: 10,
  linkForce: 0.8,
  linkDistance: 120,
};

export interface MemoLinkRef {
  targetId: string;
  label: string;
}

export interface WikiLinkRef {
  target: string;
  alias: string;
}

export interface ExtractedNoteRef {
  memoLinks: MemoLinkRef[];
  wikiLinks: WikiLinkRef[];
  inlineTags: string[];
}

export interface IndexedNoteRecord {
  id: string;
  notebookId: string;
  title: string | null;
  excerpt: string;
  kind: PluginNoteKind;
  tags: string[];
  inlineTags: string[];
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  memoLinks: MemoLinkRef[];
  wikiLinks: WikiLinkRef[];
  hasDraftOverride?: boolean;
}

export interface GraphNode {
  id: string;
  rawId: string;
  nodeType: GraphNodeType;
  label: string;
  noteKind?: PluginNoteKind;
  notebookId?: string;
  notebookPath?: string;
  tags: string[];
  excerpt: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  inDegree: number;
  outDegree: number;
  degree: number;
  radius: number;
  hopDistance?: number;
  groupId?: string;
  groupColor?: string;
  url?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  label?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  neighborsById: Map<string, Set<string>>;
  totalIndexedNotes: number;
  activeFocusNoteId: string | null;
}

export interface IndexedAttachmentRecord {
  id: string;
  noteId: string;
  kind: PluginResource["kind"];
  filename: string | null;
  mimeType: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}
