export type PluginNoteKind =
  | "text"
  | "mind-map"
  | "flowchart"
  | "architecture"
  | "table"
  | "poster"
  | "infographic"
  | "video";

export interface PluginContentNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: PluginContentNode[];
}

export interface PluginContentDocument {
  type: "doc";
  content: PluginContentNode[];
}

export type PluginJsonValue =
  | null
  | boolean
  | number
  | string
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

export interface PluginNoteSummary {
  kind: PluginNoteKind;
  id: string;
  notebookId: string;
  title: string | null;
  excerpt: string;
  tags: string[];
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PluginNote extends PluginNoteSummary {
  contentJson: PluginContentDocument;
  revision: number;
  contentMarkdown: string;
  contentText: string;
  contentHash: string;
}

export interface PluginNoteQuery {
  notebookId?: string;
  text?: string;
  tags?: string[];
  sort?: "updated-desc" | "created-desc" | "title-asc" | "title-desc";
  limit?: number;
  offset?: number;
}

export interface PluginNoteQueryResult {
  notes: PluginNoteSummary[];
  totalCount: number;
  nextOffset: number | null;
}

export interface PluginNotebook {
  id: string;
  parentId: string | null;
  name: string;
  memoCount: number;
}

export interface PluginResource {
  id: string;
  noteId: string;
  kind: "image" | "attachment";
  mimeType: string | null;
  filename: string | null;
  byteSize: number;
  contentHash: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export type PluginEventMap = {
  "settings.changed": { key: string };
  "note.created": { note: PluginNote };
  "note.updated": { note: PluginNote };
  "note.deleted": { noteId: string };
  "tag.changed": { previousName?: string; name?: string; deleted?: boolean };
  "resource.created": { resource: PluginResource };
  "resource.updated": { resource: PluginResource };
  "resource.deleted": { resourceId: string };
  "workspace.synced": { bootstrapped: boolean; changed: number };
};

export type PluginSettingValue = string | number | boolean;

export interface PluginEditorDocument {
  noteId: string;
  contentMarkdown: string;
  hasUnsavedChanges: boolean;
}

export interface PluginCommand {
  id: string;
  title: string;
  listed?: boolean;
  menu?: boolean;
  run: () => void | Promise<void>;
}

export type PluginPanelPresentation = "dialog" | "fullscreen";
export type PluginPanelPurpose = "workflow" | "dashboard" | "preview" | "onboarding";

export interface PluginPanelOpenOptions {
  state?: PluginJsonValue;
}

export type PluginPanelActionVariant = "default" | "primary" | "ghost";

export interface PluginPanelAction {
  id: string;
  label: string;
  variant?: PluginPanelActionVariant;
  disabled?: boolean;
}

export interface PluginPanelSelectOption {
  value: string;
  label: string;
}

export type PluginPanelToolbarItem =
  | { type: "search"; key: string; placeholder?: string; value?: string }
  | { type: "tabs"; key: string; value?: string; options: PluginPanelSelectOption[] }
  | { type: "select"; key: string; label?: string; value?: string; options: PluginPanelSelectOption[] }
  | { type: "button"; key: string; label: string; variant?: PluginPanelActionVariant; disabled?: boolean };

export interface PluginPanelEmptyState {
  title: string;
  description?: string;
  action?: PluginPanelAction;
}

export interface PluginPanelChrome {
  header?: {
    title?: string;
    description?: string | null;
    actions?: PluginPanelAction[];
  };
  toolbar?: PluginPanelToolbarItem[];
  empty?: PluginPanelEmptyState | null;
  onAction?: (id: string) => void;
  onChange?: (key: string, value: string) => void;
}

export interface PluginPanelShell {
  set(chrome: PluginPanelChrome): void;
}

export interface PluginPanelMountContext {
  state: PluginJsonValue | null;
  requestClose(): Promise<void>;
  shell: PluginPanelShell;
}

export interface PluginPanel {
  id: string;
  title: string;
  purpose: PluginPanelPurpose;
  presentation?: PluginPanelPresentation;
  mount(container: HTMLElement, context: PluginPanelMountContext): void | (() => void) | Promise<void | (() => void)>;
}

export interface PluginContext {
  pluginId: string;
  notes: {
    query(input?: PluginNoteQuery): Promise<PluginNoteQueryResult>;
    get(noteId: string): Promise<PluginNote>;
  };
  notebooks: {
    list(): Promise<PluginNotebook[]>;
  };
  commands: {
    register(command: PluginCommand): () => void;
  };
  events: {
    on<K extends keyof PluginEventMap>(event: K, listener: (payload: PluginEventMap[K]) => void): () => void;
  };
  storage: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
  };
  editor: {
    getDocument(): Promise<PluginEditorDocument | null>;
  };
  resources: {
    list(noteId?: string): Promise<PluginResource[]>;
  };
  settings: {
    get(key: string): Promise<PluginSettingValue | null>;
    set(key: string, value: PluginSettingValue): Promise<void>;
    remove(key: string): Promise<void>;
  };
  ui: {
    showNotice(message: string): void;
    openNote(noteId: string, options?: { search?: string }): Promise<void>;
    panels: {
      register(panel: PluginPanel): () => void;
      open(panelId: string, options?: PluginPanelOpenOptions): Promise<void>;
    };
  };
}

export interface EdgeEverPlugin {
  activate(context: PluginContext): void | (() => void) | Promise<void | (() => void)>;
  deactivate?(): void | Promise<void>;
}
