import type { PluginContext, PluginNote, PluginNotebook, PluginResource } from "./plugin-api-types";
import { extractNoteOutgoingRefs } from "./link-extractor";
import type { IndexedAttachmentRecord, IndexedNoteRecord } from "./types";

const CACHE_STORAGE_KEY = "graph-link-cache-v2";
const MAX_CACHE_SERIALIZED_CHARS = 220_000;
const QUERY_PAGE_SIZE = 200;
const NOTE_FETCH_CONCURRENCY = 6;

interface CompactCacheEntry {
  u: string;
  l: Array<[string, string]>;
  w: Array<[string, string]>;
  t: string[];
}

interface StoredGraphCache {
  version: 2;
  entries: Record<string, CompactCacheEntry>;
}

const toCompactEntry = (record: IndexedNoteRecord): CompactCacheEntry => ({
  u: record.updatedAt,
  l: record.memoLinks.map((item) => [item.targetId, item.label]),
  w: record.wikiLinks.map((item) => [item.target, item.alias]),
  t: record.inlineTags,
});

const toIndexedAttachment = (resource: PluginResource): IndexedAttachmentRecord => ({
  id: resource.id,
  noteId: resource.noteId,
  kind: resource.kind,
  filename: resource.filename,
  mimeType: resource.mimeType,
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt,
  url: resource.url,
});

const isValidCompactEntry = (value: unknown): value is CompactCacheEntry => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CompactCacheEntry>;
  return (
    typeof candidate.u === "string"
    && Array.isArray(candidate.l)
    && Array.isArray(candidate.w)
    && Array.isArray(candidate.t)
  );
};

async function runBoundedPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const runnerCount = Math.min(concurrency, items.length);
  const runners = Array.from({ length: runnerCount }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const current = items[cursor]!;
      cursor += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

export class GraphWorkspaceIndexer {
  private readonly context: PluginContext;
  private notesById = new Map<string, IndexedNoteRecord>();
  private notebooks: PluginNotebook[] = [];
  private attachmentsById = new Map<string, IndexedAttachmentRecord>();
  private attachmentsLoaded = false;
  private diskCacheLoaded = false;
  private diskCache: Record<string, CompactCacheEntry> = {};
  private inFlightSync: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(context: PluginContext) {
    this.context = context;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  getSnapshot() {
    return {
      notes: [...this.notesById.values()],
      notebooks: this.notebooks,
      attachments: [...this.attachmentsById.values()],
    };
  }

  async resolveActiveNoteId(): Promise<string | null> {
    try {
      const doc = await this.context.editor.getDocument();
      return doc?.noteId || null;
    } catch {
      return null;
    }
  }

  subscribeWorkspaceEvents(): () => void {
    const disposers = [
      this.context.events.on("note.created", ({ note }) => {
        this.upsertFullNote(note);
        void this.persistCache();
        this.notify();
      }),
      this.context.events.on("note.updated", ({ note }) => {
        this.upsertFullNote(note);
        void this.persistCache();
        this.notify();
      }),
      this.context.events.on("note.deleted", ({ noteId }) => {
        const deletedNote = this.notesById.delete(noteId);
        let deletedAttachment = false;
        for (const [attId, att] of this.attachmentsById.entries()) {
          if (att.noteId === noteId) {
            this.attachmentsById.delete(attId);
            deletedAttachment = true;
          }
        }
        delete this.diskCache[noteId];
        if (deletedNote || deletedAttachment) {
          void this.persistCache();
          this.notify();
        }
      }),
      this.context.events.on("resource.created", ({ resource }) => {
        if (!this.attachmentsLoaded) return;
        this.attachmentsById.set(resource.id, toIndexedAttachment(resource));
        this.notify();
      }),
      this.context.events.on("resource.updated", ({ resource }) => {
        if (!this.attachmentsLoaded) return;
        this.attachmentsById.set(resource.id, toIndexedAttachment(resource));
        this.notify();
      }),
      this.context.events.on("resource.deleted", ({ resourceId }) => {
        if (!this.attachmentsLoaded) return;
        if (this.attachmentsById.delete(resourceId)) this.notify();
      }),
      this.context.events.on("tag.changed", () => {
        // Re-sync note summaries on tag rename/delete without discarding unchanged note bodies
        void this.syncIndex({ maxNotes: Math.max(this.notesById.size, 1000), includeAttachments: this.attachmentsLoaded });
      }),
      this.context.events.on("workspace.synced", ({ bootstrapped, changed }) => {
        if (bootstrapped || changed > 0) {
          void this.syncIndex({ maxNotes: Math.max(this.notesById.size, 1000), includeAttachments: this.attachmentsLoaded });
        }
      }),
    ];

    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  async syncIndex(options: {
    maxNotes: number;
    includeAttachments: boolean;
    forceFull?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    if (this.inFlightSync && !options.forceFull) {
      await this.inFlightSync;
      if (options.includeAttachments && !this.attachmentsLoaded) {
        await this.ensureAttachmentsLoaded(options.signal);
      }
      return;
    }

    const run = this.performSync(options).finally(() => {
      if (this.inFlightSync === run) this.inFlightSync = null;
    });
    this.inFlightSync = run;
    await run;
  }

  async ensureAttachmentsLoaded(signal?: AbortSignal): Promise<void> {
    if (this.attachmentsLoaded || signal?.aborted) return;
    try {
      const resources = await this.context.resources.list();
      if (signal?.aborted) return;
      this.attachmentsById = new Map(resources.map((res) => [res.id, toIndexedAttachment(res)]));
      this.attachmentsLoaded = true;
      this.notify();
    } catch {
      // Attachments are optional enrichment; avoid breaking note graph rendering if listing fails.
    }
  }

  async applyActiveEditorOverlay(): Promise<string | null> {
    try {
      const doc = await this.context.editor.getDocument();
      if (!doc?.noteId) return null;
      const existing = this.notesById.get(doc.noteId);
      if (existing && doc.hasUnsavedChanges) {
        const extracted = extractNoteOutgoingRefs({
          id: doc.noteId,
          contentMarkdown: doc.contentMarkdown,
          tags: existing.tags,
          preferMarkdownOnly: true,
        });
        this.notesById.set(doc.noteId, {
          ...existing,
          memoLinks: extracted.memoLinks,
          wikiLinks: extracted.wikiLinks,
          inlineTags: extracted.inlineTags,
          hasDraftOverride: true,
        });
      }
      return doc.noteId;
    } catch {
      return null;
    }
  }

  private async loadDiskCache() {
    if (this.diskCacheLoaded) return;
    this.diskCacheLoaded = true;
    try {
      const raw = await this.context.storage.get<StoredGraphCache>(CACHE_STORAGE_KEY);
      if (raw && raw.version === 2 && raw.entries && typeof raw.entries === "object") {
        const valid: Record<string, CompactCacheEntry> = {};
        for (const [noteId, entry] of Object.entries(raw.entries)) {
          if (isValidCompactEntry(entry)) valid[noteId] = entry;
        }
        this.diskCache = valid;
      }
    } catch {
      this.diskCache = {};
    }
  }

  private async persistCache() {
    try {
      const entries: Record<string, CompactCacheEntry> = { ...this.diskCache };
      for (const note of this.notesById.values()) {
        if (!note.hasDraftOverride) {
          entries[note.id] = toCompactEntry(note);
        }
      }
      this.diskCache = entries;
      const payload: StoredGraphCache = { version: 2, entries };
      let serialized = JSON.stringify(payload);
      if (serialized.length > MAX_CACHE_SERIALIZED_CHARS) {
        const sortedIds = Object.entries(entries)
          .sort((a, b) => b[1].u.localeCompare(a[1].u))
          .slice(0, Math.floor(Object.keys(entries).length * 0.7));
        const trimmed = Object.fromEntries(sortedIds);
        this.diskCache = trimmed;
        serialized = JSON.stringify({ version: 2, entries: trimmed });
        if (serialized.length > MAX_CACHE_SERIALIZED_CHARS) return;
        await this.context.storage.set<StoredGraphCache>(CACHE_STORAGE_KEY, { version: 2, entries: trimmed });
        return;
      }
      await this.context.storage.set<StoredGraphCache>(CACHE_STORAGE_KEY, payload);
    } catch {
      // Storage quota errors should never interrupt live graph interaction.
    }
  }

  private async performSync(options: {
    maxNotes: number;
    includeAttachments: boolean;
    forceFull?: boolean;
    signal?: AbortSignal;
  }) {
    await this.loadDiskCache();
    if (options.signal?.aborted) return;

    const maxNotes = Math.min(Math.max(Math.round(options.maxNotes || 1000), 50), 5000);
    const [notebooks, summaries] = await Promise.all([
      this.context.notebooks.list(),
      this.fetchNoteSummaries(maxNotes, options.signal),
    ]);
    if (options.signal?.aborted) return;

    this.notebooks = notebooks;

    const seenIds = new Set<string>();
    const idsToFetch: string[] = [];

    for (const summary of summaries) {
      seenIds.add(summary.id);
      const existing = this.notesById.get(summary.id);
      const cached = this.diskCache[summary.id];

      if (!options.forceFull && existing && existing.updatedAt === summary.updatedAt) {
        this.notesById.set(summary.id, {
          ...existing,
          notebookId: summary.notebookId,
          title: summary.title,
          excerpt: summary.excerpt,
          kind: summary.kind,
          tags: [...summary.tags],
          isPinned: summary.isPinned,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        });
        continue;
      }

      if (!options.forceFull && cached && cached.u === summary.updatedAt) {
        this.notesById.set(summary.id, {
          id: summary.id,
          notebookId: summary.notebookId,
          title: summary.title,
          excerpt: summary.excerpt,
          kind: summary.kind,
          tags: [...summary.tags],
          inlineTags: [...cached.t],
          isPinned: summary.isPinned,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          memoLinks: cached.l.map(([targetId, label]) => ({ targetId, label })),
          wikiLinks: cached.w.map(([target, alias]) => ({ target, alias })),
        });
        continue;
      }

      idsToFetch.push(summary.id);
    }

    for (const id of this.notesById.keys()) {
      if (!seenIds.has(id)) {
        this.notesById.delete(id);
        delete this.diskCache[id];
      }
    }

    if (idsToFetch.length > 0) {
      await runBoundedPool(
        idsToFetch,
        NOTE_FETCH_CONCURRENCY,
        async (noteId) => {
          try {
            const fullNote = await this.context.notes.get(noteId);
            if (options.signal?.aborted) return;
            this.upsertFullNote(fullNote);
          } catch {
            // Note may have been deleted concurrently during indexing; omit cleanly.
          }
        },
        options.signal,
      );
    }

    if (options.signal?.aborted) return;

    await this.applyActiveEditorOverlay();

    if (options.includeAttachments && (!this.attachmentsLoaded || options.forceFull)) {
      await this.ensureAttachmentsLoaded(options.signal);
    }

    if (idsToFetch.length > 0 || options.forceFull) {
      await this.persistCache();
    }

    this.notify();
  }

  private async fetchNoteSummaries(maxNotes: number, signal?: AbortSignal) {
    const collected = [];
    let offset = 0;

    while (collected.length < maxNotes) {
      if (signal?.aborted) break;
      const limit = Math.min(QUERY_PAGE_SIZE, maxNotes - collected.length);
      const page = await this.context.notes.query({
        sort: "updated-desc",
        limit,
        offset,
      });
      collected.push(...page.notes);
      if (page.nextOffset === null || page.notes.length === 0) break;
      offset = page.nextOffset;
    }

    return collected;
  }

  private upsertFullNote(note: PluginNote) {
    const extracted = extractNoteOutgoingRefs({
      id: note.id,
      contentJson: note.contentJson,
      contentMarkdown: note.contentMarkdown,
      tags: note.tags,
    });
    const record: IndexedNoteRecord = {
      id: note.id,
      notebookId: note.notebookId,
      title: note.title,
      excerpt: note.excerpt,
      kind: note.kind,
      tags: [...note.tags],
      inlineTags: extracted.inlineTags,
      isPinned: note.isPinned,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      memoLinks: extracted.memoLinks,
      wikiLinks: extracted.wikiLinks,
    };
    this.notesById.set(note.id, record);
    this.diskCache[note.id] = toCompactEntry(record);
  }
}
