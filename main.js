// src/link-extractor.ts
var MEMO_LINK_PREFIX = "#memo=";
var parseInternalMemoHref = (href) => {
  if (typeof href !== "string" || !href.trim())
    return null;
  const trimmed = href.trim();
  const hashIndex = trimmed.lastIndexOf("#");
  const hash = hashIndex >= 0 ? trimmed.slice(hashIndex) : trimmed;
  if (hash.startsWith(MEMO_LINK_PREFIX)) {
    const encoded = hash.slice(MEMO_LINK_PREFIX.length);
    if (!encoded)
      return null;
    try {
      const decoded = decodeURIComponent(encoded);
      if (!decoded)
        return null;
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
  } catch {}
  return null;
};
var stripCodeRegions = (markdown) => {
  if (!markdown)
    return "";
  const lines = markdown.split(/\r?\n/);
  const keptLines = [];
  let activeFenceChar = null;
  let activeFenceLength = 0;
  for (const line of lines) {
    const fenceMatch = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const fenceChar = marker[0];
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
  return keptLines.join(`
`);
};
var stripInlineCodeSpans = (line) => {
  if (!line.includes("`"))
    return line;
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
    while (end < line.length && line[end] === "`")
      end += 1;
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
var collectAstMemoLinks = (contentJson, addMemoLink) => {
  if (!contentJson || typeof contentJson !== "object")
    return;
  const stack = [contentJson];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object")
      continue;
    if (node.type === "codeBlock")
      continue;
    const isInlineCode = node.marks?.some((mark) => mark.type === "code");
    if (!isInlineCode) {
      const attrHrefId = parseInternalMemoHref(node.attrs?.href);
      if (attrHrefId)
        addMemoLink(attrHrefId, typeof node.text === "string" ? node.text : "");
      if (Array.isArray(node.marks)) {
        for (const mark of node.marks) {
          const markHrefId = parseInternalMemoHref(mark.attrs?.href);
          if (markHrefId)
            addMemoLink(markHrefId, typeof node.text === "string" ? node.text : "");
        }
      }
    }
    if (Array.isArray(node.content)) {
      for (let i = node.content.length - 1;i >= 0; i -= 1) {
        stack.push(node.content[i]);
      }
    }
  }
};
var extractNoteOutgoingRefs = (input) => {
  const memoMap = new Map;
  const wikiMap = new Map;
  const inlineTagSet = new Map;
  const addMemoLink = (targetId, label) => {
    const normalizedId = targetId.trim();
    if (!normalizedId || normalizedId === input.id)
      return;
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
  const mdLinkPattern = /\[([^\]\r\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of sanitized.matchAll(mdLinkPattern)) {
    const index = match.index ?? 0;
    if (index > 0 && sanitized[index - 1] === "\\")
      continue;
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    const targetId = parseInternalMemoHref(href);
    if (targetId)
      addMemoLink(targetId, label);
  }
  const bareMemoPattern = /(?:^|[\s(<"'])((?:https?:\/\/[^\s)>'"]*)?#memo=[A-Za-z0-9_%-]+)/g;
  for (const match of sanitized.matchAll(bareMemoPattern)) {
    const targetId = parseInternalMemoHref(match[1]);
    if (targetId)
      addMemoLink(targetId, "");
  }
  const wikiPattern = /\[\[([^[\]\r\n]+)\]\]/g;
  for (const match of sanitized.matchAll(wikiPattern)) {
    const index = match.index ?? 0;
    if (index > 0 && (sanitized[index - 1] === "!" || sanitized[index - 1] === "\\"))
      continue;
    const rawInner = (match[1] ?? "").trim();
    if (!rawInner)
      continue;
    const pipeIndex = rawInner.indexOf("|");
    const targetSegment = (pipeIndex >= 0 ? rawInner.slice(0, pipeIndex) : rawInner).trim();
    const alias = (pipeIndex >= 0 ? rawInner.slice(pipeIndex + 1) : "").trim();
    const target = targetSegment.split("#")[0].split("^")[0].trim();
    if (!target)
      continue;
    const key = target.toLocaleLowerCase();
    const existing = wikiMap.get(key);
    if (!existing) {
      wikiMap.set(key, { target, alias });
    } else if (!existing.alias && alias) {
      existing.alias = alias;
    }
  }
  const withoutLinks = sanitized.replace(/\[([^\]\r\n]*)\]\(([^)\r\n]*)\)/g, " ").replace(/\[\[([^[\]\r\n]+)\]\]/g, " ").replace(/^[ ]{0,3}#{1,6}[ \t]+/gm, " ");
  const inlineTagPattern = /(?:^|[\s(>])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,63})/gu;
  for (const match of withoutLinks.matchAll(inlineTagPattern)) {
    const tag = (match[1] ?? "").replace(/\/+$/, "").trim();
    if (!tag || /^\d+$/.test(tag))
      continue;
    const lower = tag.toLocaleLowerCase();
    if (!inlineTagSet.has(lower))
      inlineTagSet.set(lower, tag);
  }
  return {
    memoLinks: [...memoMap.values()],
    wikiLinks: [...wikiMap.values()],
    inlineTags: [...inlineTagSet.values()]
  };
};

// src/graph-indexer.ts
var CACHE_STORAGE_KEY = "graph-link-cache-v2";
var MAX_CACHE_SERIALIZED_CHARS = 220000;
var QUERY_PAGE_SIZE = 200;
var NOTE_FETCH_CONCURRENCY = 6;
var toCompactEntry = (record) => ({
  u: record.updatedAt,
  l: record.memoLinks.map((item) => [item.targetId, item.label]),
  w: record.wikiLinks.map((item) => [item.target, item.alias]),
  t: record.inlineTags
});
var toIndexedAttachment = (resource) => ({
  id: resource.id,
  noteId: resource.noteId,
  kind: resource.kind,
  filename: resource.filename,
  mimeType: resource.mimeType,
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt,
  url: resource.url
});
var isValidCompactEntry = (value) => {
  if (!value || typeof value !== "object")
    return false;
  const candidate = value;
  return typeof candidate.u === "string" && Array.isArray(candidate.l) && Array.isArray(candidate.w) && Array.isArray(candidate.t);
};
async function runBoundedPool(items, concurrency, worker, signal) {
  let cursor = 0;
  const runnerCount = Math.min(concurrency, items.length);
  const runners = Array.from({ length: runnerCount }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted)
        return;
      const current = items[cursor];
      cursor += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

class GraphWorkspaceIndexer {
  context;
  notesById = new Map;
  notebooks = [];
  attachmentsById = new Map;
  attachmentsLoaded = false;
  diskCacheLoaded = false;
  diskCache = {};
  inFlightSync = null;
  listeners = new Set;
  constructor(context) {
    this.context = context;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  notify() {
    for (const listener of this.listeners)
      listener();
  }
  getSnapshot() {
    return {
      notes: [...this.notesById.values()],
      notebooks: this.notebooks,
      attachments: [...this.attachmentsById.values()]
    };
  }
  async resolveActiveNoteId() {
    try {
      const doc = await this.context.editor.getDocument();
      return doc?.noteId || null;
    } catch {
      return null;
    }
  }
  subscribeWorkspaceEvents() {
    const disposers = [
      this.context.events.on("note.created", ({ note }) => {
        this.upsertFullNote(note);
        this.persistCache();
        this.notify();
      }),
      this.context.events.on("note.updated", ({ note }) => {
        this.upsertFullNote(note);
        this.persistCache();
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
          this.persistCache();
          this.notify();
        }
      }),
      this.context.events.on("resource.created", ({ resource }) => {
        if (!this.attachmentsLoaded)
          return;
        this.attachmentsById.set(resource.id, toIndexedAttachment(resource));
        this.notify();
      }),
      this.context.events.on("resource.updated", ({ resource }) => {
        if (!this.attachmentsLoaded)
          return;
        this.attachmentsById.set(resource.id, toIndexedAttachment(resource));
        this.notify();
      }),
      this.context.events.on("resource.deleted", ({ resourceId }) => {
        if (!this.attachmentsLoaded)
          return;
        if (this.attachmentsById.delete(resourceId))
          this.notify();
      }),
      this.context.events.on("tag.changed", () => {
        this.syncIndex({ maxNotes: Math.max(this.notesById.size, 1000), includeAttachments: this.attachmentsLoaded });
      }),
      this.context.events.on("workspace.synced", ({ bootstrapped, changed }) => {
        if (bootstrapped || changed > 0) {
          this.syncIndex({ maxNotes: Math.max(this.notesById.size, 1000), includeAttachments: this.attachmentsLoaded });
        }
      })
    ];
    return () => {
      for (const dispose of disposers)
        dispose();
    };
  }
  async syncIndex(options) {
    if (this.inFlightSync && !options.forceFull) {
      await this.inFlightSync;
      if (options.includeAttachments && !this.attachmentsLoaded) {
        await this.ensureAttachmentsLoaded(options.signal);
      }
      return;
    }
    const run = this.performSync(options).finally(() => {
      if (this.inFlightSync === run)
        this.inFlightSync = null;
    });
    this.inFlightSync = run;
    await run;
  }
  async ensureAttachmentsLoaded(signal) {
    if (this.attachmentsLoaded || signal?.aborted)
      return;
    try {
      const resources = await this.context.resources.list();
      if (signal?.aborted)
        return;
      this.attachmentsById = new Map(resources.map((res) => [res.id, toIndexedAttachment(res)]));
      this.attachmentsLoaded = true;
      this.notify();
    } catch {}
  }
  async applyActiveEditorOverlay() {
    try {
      const doc = await this.context.editor.getDocument();
      if (!doc?.noteId)
        return null;
      const existing = this.notesById.get(doc.noteId);
      if (existing && doc.hasUnsavedChanges) {
        const extracted = extractNoteOutgoingRefs({
          id: doc.noteId,
          contentMarkdown: doc.contentMarkdown,
          tags: existing.tags,
          preferMarkdownOnly: true
        });
        this.notesById.set(doc.noteId, {
          ...existing,
          memoLinks: extracted.memoLinks,
          wikiLinks: extracted.wikiLinks,
          inlineTags: extracted.inlineTags,
          hasDraftOverride: true
        });
      }
      return doc.noteId;
    } catch {
      return null;
    }
  }
  async loadDiskCache() {
    if (this.diskCacheLoaded)
      return;
    this.diskCacheLoaded = true;
    try {
      const raw = await this.context.storage.get(CACHE_STORAGE_KEY);
      if (raw && raw.version === 2 && raw.entries && typeof raw.entries === "object") {
        const valid = {};
        for (const [noteId, entry] of Object.entries(raw.entries)) {
          if (isValidCompactEntry(entry))
            valid[noteId] = entry;
        }
        this.diskCache = valid;
      }
    } catch {
      this.diskCache = {};
    }
  }
  async persistCache() {
    try {
      const entries = { ...this.diskCache };
      for (const note of this.notesById.values()) {
        if (!note.hasDraftOverride) {
          entries[note.id] = toCompactEntry(note);
        }
      }
      this.diskCache = entries;
      const payload = { version: 2, entries };
      let serialized = JSON.stringify(payload);
      if (serialized.length > MAX_CACHE_SERIALIZED_CHARS) {
        const sortedIds = Object.entries(entries).sort((a, b) => b[1].u.localeCompare(a[1].u)).slice(0, Math.floor(Object.keys(entries).length * 0.7));
        const trimmed = Object.fromEntries(sortedIds);
        this.diskCache = trimmed;
        serialized = JSON.stringify({ version: 2, entries: trimmed });
        if (serialized.length > MAX_CACHE_SERIALIZED_CHARS)
          return;
        await this.context.storage.set(CACHE_STORAGE_KEY, { version: 2, entries: trimmed });
        return;
      }
      await this.context.storage.set(CACHE_STORAGE_KEY, payload);
    } catch {}
  }
  async performSync(options) {
    await this.loadDiskCache();
    if (options.signal?.aborted)
      return;
    const maxNotes = Math.min(Math.max(Math.round(options.maxNotes || 1000), 50), 5000);
    const [notebooks, summaries] = await Promise.all([
      this.context.notebooks.list(),
      this.fetchNoteSummaries(maxNotes, options.signal)
    ]);
    if (options.signal?.aborted)
      return;
    this.notebooks = notebooks;
    const seenIds = new Set;
    const idsToFetch = [];
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
          updatedAt: summary.updatedAt
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
          wikiLinks: cached.w.map(([target, alias]) => ({ target, alias }))
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
      await runBoundedPool(idsToFetch, NOTE_FETCH_CONCURRENCY, async (noteId) => {
        try {
          const fullNote = await this.context.notes.get(noteId);
          if (options.signal?.aborted)
            return;
          this.upsertFullNote(fullNote);
        } catch {}
      }, options.signal);
    }
    if (options.signal?.aborted)
      return;
    await this.applyActiveEditorOverlay();
    if (options.includeAttachments && (!this.attachmentsLoaded || options.forceFull)) {
      await this.ensureAttachmentsLoaded(options.signal);
    }
    if (idsToFetch.length > 0 || options.forceFull) {
      await this.persistCache();
    }
    this.notify();
  }
  async fetchNoteSummaries(maxNotes, signal) {
    const collected = [];
    let offset = 0;
    while (collected.length < maxNotes) {
      if (signal?.aborted)
        break;
      const limit = Math.min(QUERY_PAGE_SIZE, maxNotes - collected.length);
      const page = await this.context.notes.query({
        sort: "updated-desc",
        limit,
        offset
      });
      collected.push(...page.notes);
      if (page.nextOffset === null || page.notes.length === 0)
        break;
      offset = page.nextOffset;
    }
    return collected;
  }
  upsertFullNote(note) {
    const extracted = extractNoteOutgoingRefs({
      id: note.id,
      contentJson: note.contentJson,
      contentMarkdown: note.contentMarkdown,
      tags: note.tags
    });
    const record = {
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
      wikiLinks: extracted.wikiLinks
    };
    this.notesById.set(note.id, record);
    this.diskCache[note.id] = toCompactEntry(record);
  }
}

// src/i18n.ts
var EN_COPY = {
  pluginName: "Graph View",
  commandOpenGlobal: "Open Graph View",
  commandOpenLocal: "Open Local Graph",
  panelTitle: "Graph View",
  panelDescription: "Visualize connections across notes, tags, and attachments.",
  tabGlobal: "Global",
  tabLocal: "Local",
  searchPlaceholder: "Search (tag:, path:, file:, kind:, -exclude, OR)",
  depthLabel: "Depth",
  directionLabel: "Links",
  directionBoth: "All",
  directionOutgoing: "Outgoing",
  directionIncoming: "Incoming",
  actionAnimate: "Animate",
  actionStopAnimate: "Stop",
  actionFit: "Fit view",
  actionRefresh: "Refresh",
  actionControls: "Settings",
  actionZoomIn: "Zoom in",
  actionZoomOut: "Zoom out",
  actionReheat: "Re-layout physics",
  sectionLocalTarget: "Local Focus",
  localTargetCurrent: "Active note",
  localTargetPlaceholder: "Select focus note...",
  localNoTarget: "Open or select a note to inspect its local connections.",
  sectionFilters: "Filters",
  filterTags: "Tags",
  filterAttachments: "Attachments",
  filterExistingOnly: "Existing files only",
  filterOrphans: "Orphans",
  filterExcluded: "Excluded patterns",
  filterExcludedPlaceholder: "Archive/, tag:#draft",
  sectionGroups: "Groups",
  groupPlaceholder: "Query (e.g. tag:#project)",
  groupAdd: "New group",
  groupMoveUp: "Move group up",
  groupMoveDown: "Move group down",
  groupDelete: "Remove group",
  groupColorLabel: "Group color",
  sectionDisplay: "Display",
  displayArrows: "Arrows",
  displayTextFade: "Text fade threshold",
  displayNodeSize: "Node size",
  displayLinkThickness: "Link thickness",
  sectionForces: "Forces",
  forceCenter: "Center force",
  forceRepel: "Repel force",
  forceLink: "Link force",
  forceDistance: "Link distance",
  forcesReset: "Restore defaults",
  sectionNodes: "Visible Nodes",
  nodesCountLabel: (visible, total) => `${visible} of ${total} indexed notes`,
  statsLabel: (nodes, edges) => `${nodes} nodes · ${edges} links`,
  connectionsLabel: (inCount, outCount) => `${inCount} incoming · ${outCount} outgoing`,
  openNoteAction: "Open note",
  focusLocalAction: "Local graph",
  unresolvedBadge: "Unresolved link",
  tagBadge: "Tag",
  attachmentBadge: "Attachment",
  untitledNote: "Untitled note",
  emptyTitle: "No notes indexed yet",
  emptyDescription: "Create notes and link them with @mentions or [[WikiLinks]] to build your knowledge graph.",
  emptyFilteredTitle: "No nodes match the current filters",
  emptyFilteredDescription: "Adjust the search query, filters, or local depth to reveal connected notes.",
  emptyResetAction: "Reset filters",
  loadingLabel: "Indexing workspace graph…",
  timelapseProgress: (current, total, dateLabel) => `${current}/${total} · ${dateLabel}`,
  keyboardHelp: "Drag to pan or move node · Scroll to zoom · Arrows pan · [ ] cycle · Enter opens",
  canvasAriaLabel: "Interactive knowledge graph canvas",
  noticeNoActiveNote: "Showing Local Graph — choose a note from Local Focus or open a note first.",
  noticeUnresolvedNote: "This WikiLink points to a note that does not exist yet.",
  noticeRefreshFailed: (message) => `Graph refresh failed: ${message}`,
  sidebarAriaLabel: "Graph controls"
};
var ZH_CN_COPY = {
  pluginName: "关系图谱",
  commandOpenGlobal: "打开关系图谱",
  commandOpenLocal: "打开局部图谱",
  panelTitle: "关系图谱",
  panelDescription: "可视化笔记、标签与附件之间的知识连接网络。",
  tabGlobal: "全局图谱",
  tabLocal: "局部图谱",
  searchPlaceholder: "搜索（tag:、path:、file:、kind:、-排除、OR）",
  depthLabel: "深度",
  directionLabel: "方向",
  directionBoth: "全部",
  directionOutgoing: "出链",
  directionIncoming: "入链",
  actionAnimate: "时间轴动画",
  actionStopAnimate: "停止动画",
  actionFit: "适应画布",
  actionRefresh: "刷新索引",
  actionControls: "图谱控制",
  actionZoomIn: "放大",
  actionZoomOut: "缩小",
  actionReheat: "重新布局",
  sectionLocalTarget: "局部焦点",
  localTargetCurrent: "焦点笔记",
  localTargetPlaceholder: "选择焦点笔记...",
  localNoTarget: "打开或在下方选择一条笔记以查看其局部邻域连接。",
  sectionFilters: "筛选器",
  filterTags: "标签",
  filterAttachments: "附件",
  filterExistingOnly: "仅显示已存在笔记",
  filterOrphans: "孤立笔记",
  filterExcluded: "排除规则",
  filterExcludedPlaceholder: "Archive/, tag:#draft",
  sectionGroups: "分组着色",
  groupPlaceholder: "查询规则（例如 tag:#project）",
  groupAdd: "新建分组",
  groupMoveUp: "上移分组",
  groupMoveDown: "下移分组",
  groupDelete: "删除分组",
  groupColorLabel: "分组颜色",
  sectionDisplay: "显示",
  displayArrows: "方向箭头",
  displayTextFade: "文字淡出阈值",
  displayNodeSize: "节点大小",
  displayLinkThickness: "连线粗细",
  sectionForces: "力学参数",
  forceCenter: "向心力",
  forceRepel: "排斥力",
  forceLink: "连接引力",
  forceDistance: "连接距离",
  forcesReset: "恢复默认",
  sectionNodes: "可见节点",
  nodesCountLabel: (visible, total) => `当前显示 ${visible} 个节点（共索引 ${total} 篇笔记）`,
  statsLabel: (nodes, edges) => `${nodes} 个节点 · ${edges} 条连接`,
  connectionsLabel: (inCount, outCount) => `${inCount} 入链 · ${outCount} 出链`,
  openNoteAction: "打开笔记",
  focusLocalAction: "局部图谱",
  unresolvedBadge: "未创建链接",
  tagBadge: "标签",
  attachmentBadge: "附件",
  untitledNote: "无标题笔记",
  emptyTitle: "暂无可展示的笔记",
  emptyDescription: "创建笔记并使用 @引用 或 [[双链]] 建立关联后即可查看关系图谱。",
  emptyFilteredTitle: "没有节点符合当前筛选条件",
  emptyFilteredDescription: "尝试放宽搜索条件、筛选开关或增大局部图谱深度。",
  emptyResetAction: "重置筛选",
  loadingLabel: "正在索引笔记网络…",
  timelapseProgress: (current, total, dateLabel) => `${current}/${total} · ${dateLabel}`,
  keyboardHelp: "拖拽平移或移动节点 · 滚轮缩放 · 方向键平移 · [ ] 切换节点 · Enter 打开",
  canvasAriaLabel: "交互式知识图谱画布",
  noticeNoActiveNote: "已打开局部图谱，请在右侧选择一条焦点笔记。",
  noticeUnresolvedNote: "该双链指向的笔记尚未创建。",
  noticeRefreshFailed: (message) => `图谱刷新失败：${message}`,
  sidebarAriaLabel: "图谱控制面板"
};
var VI_COPY = {
  pluginName: "Biểu đồ liên kết",
  commandOpenGlobal: "Mở Biểu đồ liên kết",
  commandOpenLocal: "Mở Biểu đồ cục bộ",
  panelTitle: "Biểu đồ liên kết",
  panelDescription: "Trực quan hóa mạng lưới liên kết giữa ghi chú, thẻ và tệp đính kèm.",
  tabGlobal: "Toàn cục",
  tabLocal: "Cục bộ",
  searchPlaceholder: "Tìm kiếm (tag:, path:, file:, kind:, -loại trừ, OR)",
  depthLabel: "Độ sâu",
  directionLabel: "Hướng",
  directionBoth: "Tất cả",
  directionOutgoing: "Đi ra",
  directionIncoming: "Đi vào",
  actionAnimate: "Phát tiến trình",
  actionStopAnimate: "Dừng",
  actionFit: "Vừa khung",
  actionRefresh: "Làm mới",
  actionControls: "Cài đặt",
  actionZoomIn: "Phóng to",
  actionZoomOut: "Thu nhỏ",
  actionReheat: "Sắp xếp lại",
  sectionLocalTarget: "Ghi chú trung tâm",
  localTargetCurrent: "Ghi chú đang chọn",
  localTargetPlaceholder: "Chọn ghi chú trung tâm...",
  localNoTarget: "Hãy mở hoặc chọn một ghi chú để xem các kết nối cục bộ.",
  sectionFilters: "Bộ lọc",
  filterTags: "Thẻ",
  filterAttachments: "Tệp đính kèm",
  filterExistingOnly: "Chỉ tệp hiện có",
  filterOrphans: "Ghi chú cô lập",
  filterExcluded: "Mẫu loại trừ",
  filterExcludedPlaceholder: "Archive/, tag:#draft",
  sectionGroups: "Nhóm màu",
  groupPlaceholder: "Truy vấn (vd: tag:#project)",
  groupAdd: "Thêm nhóm",
  groupMoveUp: "Di chuyển lên",
  groupMoveDown: "Di chuyển xuống",
  groupDelete: "Xóa nhóm",
  groupColorLabel: "Màu nhóm",
  sectionDisplay: "Hiển thị",
  displayArrows: "Mũi tên",
  displayTextFade: "Ngưỡng mờ nhãn",
  displayNodeSize: "Kích thước nút",
  displayLinkThickness: "Độ dày liên kết",
  sectionForces: "Lực vật lý",
  forceCenter: "Lực hướng tâm",
  forceRepel: "Lực đẩy",
  forceLink: "Lực kéo liên kết",
  forceDistance: "Khoảng cách liên kết",
  forcesReset: "Khôi phục mặc định",
  sectionNodes: "Nút hiển thị",
  nodesCountLabel: (visible, total) => `${visible} nút hiển thị · ${total} ghi chú đã lập chỉ mục`,
  statsLabel: (nodes, edges) => `${nodes} nút · ${edges} liên kết`,
  connectionsLabel: (inCount, outCount) => `${inCount} đến · ${outCount} đi`,
  openNoteAction: "Mở ghi chú",
  focusLocalAction: "Biểu đồ cục bộ",
  unresolvedBadge: "Liên kết chưa tạo",
  tagBadge: "Thẻ",
  attachmentBadge: "Tệp đính kèm",
  untitledNote: "Ghi chú chưa đặt tên",
  emptyTitle: "Chưa có ghi chú nào",
  emptyDescription: "Tạo ghi chú và kết nối bằng @mention hoặc [[WikiLink]] để xây dựng biểu đồ tri thức.",
  emptyFilteredTitle: "Không có nút nào khớp bộ lọc",
  emptyFilteredDescription: "Thử thay đổi từ khóa tìm kiếm, bộ lọc hoặc tăng độ sâu cục bộ.",
  emptyResetAction: "Đặt lại bộ lọc",
  loadingLabel: "Đang lập chỉ mục biểu đồ…",
  timelapseProgress: (current, total, dateLabel) => `${current}/${total} · ${dateLabel}`,
  keyboardHelp: "Kéo để xoay/di chuyển · Cuộn để thu phóng · Phím mũi tên di chuyển · [ ] chọn nút · Enter để mở",
  canvasAriaLabel: "Khung vẽ biểu đồ tri thức tương tác",
  noticeNoActiveNote: "Đang mở Biểu đồ cục bộ — hãy chọn ghi chú trung tâm ở thanh điều khiển.",
  noticeUnresolvedNote: "WikiLink này trỏ tới một ghi chú chưa được tạo.",
  noticeRefreshFailed: (message) => `Làm mới biểu đồ thất bại: ${message}`,
  sidebarAriaLabel: "Bảng điều khiển biểu đồ"
};
var detectGraphLocale = () => {
  const raw = ((typeof document !== "undefined" ? document.documentElement?.lang : "") || (typeof navigator !== "undefined" ? navigator.language : "") || "en").toLocaleLowerCase();
  if (raw.startsWith("zh"))
    return "zh-CN";
  if (raw.startsWith("vi"))
    return "vi";
  return "en";
};
var getGraphCopy = (locale = detectGraphLocale()) => {
  if (locale === "zh-CN")
    return ZH_CN_COPY;
  if (locale === "vi")
    return VI_COPY;
  return EN_COPY;
};

// src/canvas-renderer.ts
var LIGHT_FALLBACK_PALETTE = {
  bg: "#f8fafc",
  surface: "#ffffff",
  text: "#0f172a",
  textMuted: "#64748b",
  accent: "#16a06e",
  nodeDefault: "#475569",
  nodeTag: "#0d9488",
  nodeAttachment: "#6366f1",
  nodeUnresolved: "#94a3b8",
  edge: "rgba(100, 116, 139, 0.42)",
  border: "#cbd5e1"
};
var DARK_FALLBACK_PALETTE = {
  bg: "#0b1120",
  surface: "#111827",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  accent: "#34d399",
  nodeDefault: "#cbd5e1",
  nodeTag: "#2dd4bf",
  nodeAttachment: "#818cf8",
  nodeUnresolved: "#64748b",
  edge: "rgba(148, 163, 184, 0.34)",
  border: "#334155"
};

class GraphCanvasRenderer {
  rootElement;
  canvas;
  simulation;
  onHoverNode;
  onActivateNode;
  onFocusLocalNode;
  onTimelapseState;
  graphData = null;
  display = {
    showArrows: false,
    textFadeThreshold: 0,
    nodeSize: 1,
    linkThickness: 1
  };
  width = 640;
  height = 420;
  dpr = 1;
  panX = 0;
  panY = 0;
  zoom = 1;
  hasFittedInitial = false;
  hoveredId = null;
  selectedId = null;
  draggedNodeId = null;
  isPanning = false;
  pointerDownPos = { x: 0, y: 0 };
  lastPointerPos = { x: 0, y: 0 };
  pointerMovedDist = 0;
  activePointers = new Map;
  lastPinchDist = null;
  rafId = null;
  resizeObserver = null;
  themeObserver = null;
  mediaQuery = null;
  palette = LIGHT_FALLBACK_PALETTE;
  timelapseRunning = false;
  timelapseOrder = [];
  timelapseProgress = 0;
  timelapseLastTickMs = 0;
  disposers = [];
  constructor(options) {
    this.rootElement = options.rootElement;
    this.canvas = options.canvas;
    this.simulation = options.simulation;
    this.onHoverNode = options.onHoverNode;
    this.onActivateNode = options.onActivateNode;
    this.onFocusLocalNode = options.onFocusLocalNode;
    this.onTimelapseState = options.onTimelapseState;
    this.refreshPalette();
    this.setupObservers();
    this.bindEvents();
    this.measureCanvas();
  }
  setGraphData(data, display, options) {
    const prevCount = this.graphData?.nodes.length ?? 0;
    this.graphData = data;
    this.display = { ...display };
    if (this.hoveredId && !data.nodeById.has(this.hoveredId)) {
      this.hoveredId = null;
      this.onHoverNode(null);
    }
    if (this.selectedId && !data.nodeById.has(this.selectedId)) {
      this.selectedId = null;
    }
    if (this.timelapseRunning) {
      this.rebuildTimelapseOrder();
    }
    if (!this.hasFittedInitial && data.nodes.length > 0 || prevCount === 0 && data.nodes.length > 0 && options?.fitIfFirst !== false) {
      this.hasFittedInitial = true;
      this.simulation.tick(Math.min(120, 40 + data.nodes.length));
      this.fitToView();
    } else {
      this.scheduleFrame();
    }
  }
  setDisplay(display) {
    this.display = { ...display };
    this.scheduleFrame();
  }
  focusNodeById(nodeId) {
    this.selectedId = nodeId;
    if (nodeId && this.graphData) {
      const node = this.graphData.nodeById.get(nodeId) ?? null;
      const sim = this.simulation.nodeMap.get(nodeId);
      if (sim) {
        this.panX = -sim.x * this.zoom;
        this.panY = -sim.y * this.zoom;
      }
      this.onHoverNode(node);
    }
    this.scheduleFrame();
  }
  zoomBy(factor, anchorScreen) {
    const prevZoom = this.zoom;
    const nextZoom = Math.min(Math.max(prevZoom * factor, 0.12), 5.5);
    if (nextZoom === prevZoom)
      return;
    const cx = (anchorScreen?.x ?? this.width * 0.5) - this.width * 0.5;
    const cy = (anchorScreen?.y ?? this.height * 0.5) - this.height * 0.5;
    const ratio = nextZoom / prevZoom;
    this.panX = cx - (cx - this.panX) * ratio;
    this.panY = cy - (cy - this.panY) * ratio;
    this.zoom = nextZoom;
    this.scheduleFrame();
  }
  fitToView() {
    if (!this.simulation.nodes.length) {
      this.panX = 0;
      this.panY = 0;
      this.zoom = 1;
      this.scheduleFrame();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.simulation.nodes) {
      const pad = node.radius + 24;
      if (node.x - pad < minX)
        minX = node.x - pad;
      if (node.y - pad < minY)
        minY = node.y - pad;
      if (node.x + pad > maxX)
        maxX = node.x + pad;
      if (node.y + pad > maxY)
        maxY = node.y + pad;
    }
    const spanW = Math.max(80, maxX - minX);
    const spanH = Math.max(80, maxY - minY);
    const margin = 0.84;
    const fitZoom = Math.min(this.width * margin / spanW, this.height * margin / spanH, 2.2);
    this.zoom = Math.max(0.15, fitZoom);
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    this.panX = -centerX * this.zoom;
    this.panY = -centerY * this.zoom;
    this.scheduleFrame();
  }
  toggleTimelapse() {
    if (this.timelapseRunning) {
      this.stopTimelapse();
      return;
    }
    if (!this.graphData || this.graphData.nodes.length === 0)
      return;
    this.timelapseRunning = true;
    this.rebuildTimelapseOrder();
    this.timelapseProgress = 1;
    this.timelapseLastTickMs = performance.now();
    this.emitTimelapseProgress();
    this.scheduleFrame();
  }
  stopTimelapse() {
    if (!this.timelapseRunning)
      return;
    this.timelapseRunning = false;
    this.timelapseOrder = [];
    this.onTimelapseState?.({ running: false, current: 0, total: 0, dateLabel: "" });
    this.scheduleFrame();
  }
  isTimelapseRunning() {
    return this.timelapseRunning;
  }
  destroy() {
    if (this.rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    for (const dispose of this.disposers)
      dispose();
  }
  rebuildTimelapseOrder() {
    if (!this.graphData) {
      this.timelapseOrder = [];
      return;
    }
    const sorted = [...this.graphData.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.timelapseOrder = sorted.map((node) => node.id);
    if (this.timelapseProgress > this.timelapseOrder.length) {
      this.timelapseProgress = this.timelapseOrder.length;
    }
  }
  emitTimelapseProgress() {
    if (!this.graphData || !this.timelapseRunning)
      return;
    const total = this.timelapseOrder.length;
    const current = Math.min(total, Math.max(1, Math.floor(this.timelapseProgress)));
    const currentNodeId = this.timelapseOrder[current - 1];
    const currentNode = currentNodeId ? this.graphData.nodeById.get(currentNodeId) : null;
    const dateLabel = currentNode?.createdAt ? currentNode.createdAt.slice(0, 10) : "";
    this.onTimelapseState?.({ running: true, current, total, dateLabel });
  }
  isDarkMode() {
    const docRoot = typeof document !== "undefined" ? document.documentElement : null;
    if (docRoot?.classList.contains("dark"))
      return true;
    if (docRoot?.classList.contains("light"))
      return false;
    return Boolean(this.mediaQuery?.matches);
  }
  refreshPalette() {
    const dark = this.isDarkMode();
    const fallback = dark ? DARK_FALLBACK_PALETTE : LIGHT_FALLBACK_PALETTE;
    if (typeof getComputedStyle !== "function") {
      this.palette = fallback;
      return;
    }
    const styles = getComputedStyle(this.rootElement);
    const readVar = (name, fb) => {
      const value = styles.getPropertyValue(name).trim();
      return value || fb;
    };
    this.palette = {
      bg: readVar("--ee-gv-bg", fallback.bg),
      surface: readVar("--ee-gv-surface", fallback.surface),
      text: readVar("--ee-gv-text", fallback.text),
      textMuted: readVar("--ee-gv-text-muted", fallback.textMuted),
      accent: readVar("--ee-gv-accent", fallback.accent),
      nodeDefault: readVar("--ee-gv-node-default", fallback.nodeDefault),
      nodeTag: readVar("--ee-gv-node-tag", fallback.nodeTag),
      nodeAttachment: readVar("--ee-gv-node-attachment", fallback.nodeAttachment),
      nodeUnresolved: readVar("--ee-gv-node-unresolved", fallback.nodeUnresolved),
      edge: readVar("--ee-gv-edge", fallback.edge),
      border: readVar("--ee-gv-border", fallback.border)
    };
  }
  setupObservers() {
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.measureCanvas());
      this.resizeObserver.observe(this.canvas);
    }
    if (typeof MutationObserver === "function" && typeof document !== "undefined" && document.documentElement) {
      this.themeObserver = new MutationObserver(() => {
        this.refreshPalette();
        this.scheduleFrame();
      });
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"]
      });
    }
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      this.mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const onSchemeChange = () => {
        this.refreshPalette();
        this.scheduleFrame();
      };
      this.mediaQuery.addEventListener?.("change", onSchemeChange);
      this.disposers.push(() => this.mediaQuery?.removeEventListener?.("change", onSchemeChange));
    }
  }
  measureCanvas() {
    const rect = this.canvas.getBoundingClientRect?.();
    const width = Math.max(240, Math.round(rect?.width || this.canvas.clientWidth || 640));
    const height = Math.max(220, Math.round(rect?.height || this.canvas.clientHeight || 420));
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2.5);
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.scheduleFrame();
  }
  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      screenX: sx,
      screenY: sy,
      worldX: (sx - this.width * 0.5 - this.panX) / this.zoom,
      worldY: (sy - this.height * 0.5 - this.panY) / this.zoom
    };
  }
  hitTest(worldX, worldY) {
    const tolerance = 6 / this.zoom;
    for (let i = this.simulation.nodes.length - 1;i >= 0; i -= 1) {
      const node = this.simulation.nodes[i];
      const hitRadius = Math.max(node.radius + tolerance, 10 / this.zoom);
      const dx = worldX - node.x;
      const dy = worldY - node.y;
      if (dx * dx + dy * dy <= hitRadius * hitRadius)
        return node;
    }
    return null;
  }
  bindEvents() {
    const onPointerDown = (event) => {
      if (event.button !== 0 && event.pointerType === "mouse")
        return;
      this.canvas.focus({ preventScroll: true });
      this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.canvas.setPointerCapture?.(event.pointerId);
      if (this.activePointers.size === 2) {
        this.draggedNodeId = null;
        this.isPanning = false;
        const pts = [...this.activePointers.values()];
        this.lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        return;
      }
      const pos = this.screenToWorld(event.clientX, event.clientY);
      this.pointerDownPos = { x: event.clientX, y: event.clientY };
      this.lastPointerPos = { x: event.clientX, y: event.clientY };
      this.pointerMovedDist = 0;
      const hit = this.hitTest(pos.worldX, pos.worldY);
      if (hit) {
        this.draggedNodeId = hit.id;
        this.selectedId = hit.id;
        this.simulation.pinNode(hit.id, hit.x, hit.y);
        this.simulation.alphaTarget = 0.25;
        this.canvas.dataset.dragging = "true";
        const gn = this.graphData?.nodeById.get(hit.id) ?? null;
        this.onHoverNode(gn);
      } else {
        this.isPanning = true;
        this.canvas.dataset.dragging = "true";
      }
      this.scheduleFrame();
    };
    const onPointerMove = (event) => {
      if (this.activePointers.has(event.pointerId)) {
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (this.activePointers.size === 2) {
        const pts = [...this.activePointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        if (this.lastPinchDist && dist > 0) {
          const midX = (pts[0].x + pts[1].x) * 0.5;
          const midY = (pts[0].y + pts[1].y) * 0.5;
          const rect = this.canvas.getBoundingClientRect();
          this.zoomBy(dist / this.lastPinchDist, { x: midX - rect.left, y: midY - rect.top });
        }
        this.lastPinchDist = dist;
        return;
      }
      const dxScreen = event.clientX - this.lastPointerPos.x;
      const dyScreen = event.clientY - this.lastPointerPos.y;
      this.lastPointerPos = { x: event.clientX, y: event.clientY };
      this.pointerMovedDist += Math.hypot(dxScreen, dyScreen);
      if (this.draggedNodeId) {
        const pos2 = this.screenToWorld(event.clientX, event.clientY);
        this.simulation.pinNode(this.draggedNodeId, pos2.worldX, pos2.worldY);
        this.simulation.reheat(0.4);
        this.scheduleFrame();
        return;
      }
      if (this.isPanning) {
        this.panX += dxScreen;
        this.panY += dyScreen;
        this.scheduleFrame();
        return;
      }
      const pos = this.screenToWorld(event.clientX, event.clientY);
      const hit = this.hitTest(pos.worldX, pos.worldY);
      const nextHoveredId = hit?.id ?? null;
      if (nextHoveredId !== this.hoveredId) {
        this.hoveredId = nextHoveredId;
        this.canvas.dataset.hovering = nextHoveredId ? "true" : "false";
        const gn = nextHoveredId ? this.graphData?.nodeById.get(nextHoveredId) ?? null : null;
        this.onHoverNode(gn);
        this.scheduleFrame();
      }
    };
    const endPointer = (event) => {
      this.activePointers.delete(event.pointerId);
      if (this.activePointers.size < 2)
        this.lastPinchDist = null;
      if (this.draggedNodeId) {
        const activatedId = this.draggedNodeId;
        this.simulation.unpinNode(this.draggedNodeId);
        this.simulation.alphaTarget = 0;
        this.draggedNodeId = null;
        this.canvas.dataset.dragging = "false";
        if (this.pointerMovedDist < 5 && this.graphData) {
          const node = this.graphData.nodeById.get(activatedId);
          if (node)
            this.onActivateNode(node);
        }
        this.scheduleFrame();
        return;
      }
      if (this.isPanning) {
        this.isPanning = false;
        this.canvas.dataset.dragging = "false";
        if (this.pointerMovedDist < 5 && event.type === "pointerup") {
          const movedFromDown = Math.hypot(event.clientX - this.pointerDownPos.x, event.clientY - this.pointerDownPos.y);
          if (movedFromDown < 5 && this.selectedId) {
            this.selectedId = null;
            this.onHoverNode(null);
            this.scheduleFrame();
          }
        }
      }
    };
    const onPointerLeave = () => {
      if (this.hoveredId && !this.draggedNodeId) {
        this.hoveredId = null;
        this.canvas.dataset.hovering = "false";
        if (!this.selectedId)
          this.onHoverNode(null);
        this.scheduleFrame();
      }
    };
    const onWheel = (event) => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * 0.0014);
      this.zoomBy(factor, anchor);
    };
    const onDblClick = (event) => {
      const pos = this.screenToWorld(event.clientX, event.clientY);
      const hit = this.hitTest(pos.worldX, pos.worldY);
      if (!hit) {
        this.fitToView();
      } else {
        const node = this.graphData?.nodeById.get(hit.id);
        if (node)
          this.onFocusLocalNode(node);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        this.zoomBy(1.2);
      } else if (event.key === "-") {
        event.preventDefault();
        this.zoomBy(1 / 1.2);
      } else if (event.key === "0") {
        event.preventDefault();
        this.fitToView();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.panX += 48;
        this.scheduleFrame();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        this.panX -= 48;
        this.scheduleFrame();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.panY += 48;
        this.scheduleFrame();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        this.panY -= 48;
        this.scheduleFrame();
      } else if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        this.cycleSelectedNode(event.key === "]" ? 1 : -1);
      } else if ((event.key === "Enter" || event.key === " ") && this.selectedId) {
        event.preventDefault();
        const node = this.graphData?.nodeById.get(this.selectedId);
        if (node)
          this.onActivateNode(node);
      } else if ((event.key === "l" || event.key === "L") && this.selectedId) {
        event.preventDefault();
        const node = this.graphData?.nodeById.get(this.selectedId);
        if (node)
          this.onFocusLocalNode(node);
      } else if (event.key === "Escape") {
        this.selectedId = null;
        this.hoveredId = null;
        this.onHoverNode(null);
        this.scheduleFrame();
      }
    };
    this.canvas.addEventListener("pointerdown", onPointerDown);
    this.canvas.addEventListener("pointermove", onPointerMove);
    this.canvas.addEventListener("pointerup", endPointer);
    this.canvas.addEventListener("pointercancel", endPointer);
    this.canvas.addEventListener("pointerleave", onPointerLeave);
    this.canvas.addEventListener("wheel", onWheel, { passive: false });
    this.canvas.addEventListener("dblclick", onDblClick);
    this.canvas.addEventListener("keydown", onKeyDown);
    this.disposers.push(() => {
      this.canvas.removeEventListener("pointerdown", onPointerDown);
      this.canvas.removeEventListener("pointermove", onPointerMove);
      this.canvas.removeEventListener("pointerup", endPointer);
      this.canvas.removeEventListener("pointercancel", endPointer);
      this.canvas.removeEventListener("pointerleave", onPointerLeave);
      this.canvas.removeEventListener("wheel", onWheel);
      this.canvas.removeEventListener("dblclick", onDblClick);
      this.canvas.removeEventListener("keydown", onKeyDown);
    });
  }
  cycleSelectedNode(delta) {
    if (!this.graphData || this.graphData.nodes.length === 0)
      return;
    const sorted = [...this.graphData.nodes].sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
    const currentIndex = this.selectedId ? sorted.findIndex((item) => item.id === this.selectedId) : -1;
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + sorted.length) % sorted.length;
    const target = sorted[nextIndex];
    this.focusNodeById(target.id);
  }
  scheduleFrame() {
    if (this.rafId !== null)
      return;
    if (typeof requestAnimationFrame !== "function") {
      this.renderFrame(performance.now());
      return;
    }
    this.rafId = requestAnimationFrame((now) => {
      this.rafId = null;
      this.renderFrame(now);
    });
  }
  renderFrame(now) {
    const runningPhysics = this.simulation.step();
    let timelapseActive = false;
    if (this.timelapseRunning && this.timelapseOrder.length > 0) {
      const elapsedSec = Math.min(0.1, Math.max(0.008, (now - this.timelapseLastTickMs) / 1000));
      this.timelapseLastTickMs = now;
      const nodesPerSec = Math.max(4, this.timelapseOrder.length / 5.5);
      this.timelapseProgress += elapsedSec * nodesPerSec;
      this.emitTimelapseProgress();
      if (this.timelapseProgress >= this.timelapseOrder.length) {
        this.timelapseRunning = false;
        this.timelapseOrder = [];
        this.onTimelapseState?.({ running: false, current: 0, total: 0, dateLabel: "" });
      } else {
        timelapseActive = true;
      }
    }
    this.draw();
    if (runningPhysics || timelapseActive || this.draggedNodeId || this.isPanning) {
      this.scheduleFrame();
    }
  }
  draw() {
    const ctx = this.canvas.getContext?.("2d");
    if (!ctx || !this.graphData)
      return;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = this.palette.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.translate(this.width * 0.5 + this.panX, this.height * 0.5 + this.panY);
    ctx.scale(this.zoom, this.zoom);
    const visibleSet = this.timelapseRunning ? new Set(this.timelapseOrder.slice(0, Math.max(1, Math.floor(this.timelapseProgress)))) : null;
    const focusActiveId = this.hoveredId ?? this.selectedId;
    const activeNeighbors = focusActiveId ? this.graphData.neighborsById.get(focusActiveId) ?? null : null;
    const baseLineWidth = Math.max(0.45, this.display.linkThickness) / Math.sqrt(Math.max(this.zoom, 0.5));
    for (const edge of this.graphData.edges) {
      if (visibleSet && (!visibleSet.has(edge.source) || !visibleSet.has(edge.target)))
        continue;
      const src = this.simulation.nodeMap.get(edge.source);
      const tgt = this.simulation.nodeMap.get(edge.target);
      if (!src || !tgt)
        continue;
      const isIncident = focusActiveId !== null && (edge.source === focusActiveId || edge.target === focusActiveId);
      ctx.save();
      ctx.globalAlpha = focusActiveId ? isIncident ? 0.92 : 0.14 : 1;
      ctx.lineWidth = isIncident ? baseLineWidth * 1.85 : baseLineWidth;
      ctx.strokeStyle = isIncident ? this.palette.accent : this.palette.edge;
      if (edge.kind === "unresolved") {
        ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
      }
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.stroke();
      if (this.display.showArrows) {
        this.drawArrowhead(ctx, src, tgt, isIncident ? this.palette.accent : this.palette.edge);
      }
      ctx.restore();
    }
    for (const simNode of this.simulation.nodes) {
      if (visibleSet && !visibleSet.has(simNode.id))
        continue;
      const gn = this.graphData.nodeById.get(simNode.id);
      if (!gn)
        continue;
      const isPrimary = simNode.id === focusActiveId;
      const isNeighbor = Boolean(activeNeighbors?.has(simNode.id));
      const isDimmed = Boolean(focusActiveId && !isPrimary && !isNeighbor);
      const color = this.resolveNodeColor(gn);
      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.18 : 1;
      this.drawNodeShape(ctx, simNode.x, simNode.y, simNode.radius, gn, color, isPrimary);
      ctx.restore();
    }
    const fadeMinZoom = Math.pow(1.45, this.display.textFadeThreshold) * 0.55;
    const baseLabelAlpha = Math.max(0, Math.min(1, (this.zoom - fadeMinZoom * 0.65) / Math.max(0.25, fadeMinZoom * 0.7)));
    const fontSize = Math.max(9.5, Math.min(14, 11.5 / Math.pow(this.zoom, 0.42)));
    ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const simNode of this.simulation.nodes) {
      if (visibleSet && !visibleSet.has(simNode.id))
        continue;
      const gn = this.graphData.nodeById.get(simNode.id);
      if (!gn)
        continue;
      const isPrimary = simNode.id === focusActiveId;
      const isNeighbor = Boolean(activeNeighbors?.has(simNode.id));
      const isFocalLocal = gn.hopDistance === 0;
      const labelAlpha = isPrimary || isNeighbor || isFocalLocal ? 1 : focusActiveId ? Math.min(baseLabelAlpha, 0.14) : baseLabelAlpha;
      if (labelAlpha <= 0.04)
        continue;
      const text = gn.label.length > 36 ? `${gn.label.slice(0, 35)}…` : gn.label;
      ctx.save();
      ctx.globalAlpha = labelAlpha;
      const labelY = simNode.y + simNode.radius + 4 / Math.sqrt(Math.max(this.zoom, 0.6));
      ctx.lineWidth = 3 / Math.max(this.zoom, 0.5);
      ctx.strokeStyle = this.palette.bg;
      ctx.strokeText(text, simNode.x, labelY);
      ctx.fillStyle = isPrimary ? this.palette.text : gn.nodeType === "unresolved" ? this.palette.textMuted : this.palette.text;
      ctx.fillText(text, simNode.x, labelY);
      ctx.restore();
    }
    ctx.restore();
  }
  resolveNodeColor(node) {
    if (node.groupColor)
      return node.groupColor;
    if (node.hopDistance === 0)
      return this.palette.accent;
    if (node.nodeType === "tag")
      return this.palette.nodeTag;
    if (node.nodeType === "attachment")
      return this.palette.nodeAttachment;
    if (node.nodeType === "unresolved")
      return this.palette.nodeUnresolved;
    return this.palette.nodeDefault;
  }
  drawNodeShape(ctx, x, y, radius, node, color, isHighlighted) {
    ctx.fillStyle = color;
    ctx.strokeStyle = isHighlighted ? this.palette.accent : this.palette.bg;
    ctx.lineWidth = (isHighlighted ? 2.4 : 1.2) / Math.sqrt(Math.max(this.zoom, 0.6));
    if (node.nodeType === "tag") {
      const r = radius * 1.15;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (node.nodeType === "attachment") {
      const side = radius * 1.8;
      const half = side * 0.5;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x - half, y - half, side, side, Math.max(2, radius * 0.35));
      } else {
        ctx.rect(x - half, y - half, side, side);
      }
      ctx.fill();
      ctx.stroke();
    } else if (node.nodeType === "unresolved") {
      ctx.save();
      ctx.globalAlpha *= 0.25;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.setLineDash([3 / this.zoom, 2.5 / this.zoom]);
      ctx.strokeStyle = color;
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (node.hopDistance === 0 || isHighlighted) {
      ctx.beginPath();
      ctx.strokeStyle = this.palette.accent;
      ctx.lineWidth = 2 / Math.sqrt(Math.max(this.zoom, 0.7));
      ctx.arc(x, y, radius + 3.5 / Math.sqrt(Math.max(this.zoom, 0.7)), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  drawArrowhead(ctx, src, tgt, color) {
    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    const dist = Math.hypot(dx, dy);
    if (dist < tgt.radius + 4)
      return;
    const ux = dx / dist;
    const uy = dy / dist;
    const tipX = tgt.x - ux * (tgt.radius + 2);
    const tipY = tgt.y - uy * (tgt.radius + 2);
    const size = Math.max(5.5, 6.5 / Math.sqrt(Math.max(this.zoom, 0.55)));
    const angle = Math.atan2(uy, ux);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - Math.cos(angle - 0.45) * size, tipY - Math.sin(angle - 0.45) * size);
    ctx.lineTo(tipX - Math.cos(angle + 0.45) * size, tipY - Math.sin(angle + 0.45) * size);
    ctx.closePath();
    ctx.fill();
  }
}

// src/force-simulation.ts
var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
var BARNES_HUT_THETA = 0.75;
var QUADTREE_THRESHOLD = 80;
var MAX_QUADTREE_DEPTH = 24;
var hashStringUnit = (value) => {
  let hash = 2166136261;
  for (let i = 0;i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 1e4 / 1e4;
};
var createQuadNode = (x, y, size) => ({
  x,
  y,
  size,
  mass: 0,
  cx: 0,
  cy: 0,
  body: null,
  children: null
});
var insertBody = (quad, body, depth = 0) => {
  const bodyMass = 1 + Math.min(body.degree, 12) * 0.08;
  const nextMass = quad.mass + bodyMass;
  quad.cx = (quad.cx * quad.mass + body.x * bodyMass) / nextMass;
  quad.cy = (quad.cy * quad.mass + body.y * bodyMass) / nextMass;
  quad.mass = nextMass;
  if (!quad.children) {
    if (!quad.body) {
      quad.body = body;
      return;
    }
    if (depth >= MAX_QUADTREE_DEPTH)
      return;
    const half = quad.size * 0.5;
    quad.children = [
      createQuadNode(quad.x, quad.y, half),
      createQuadNode(quad.x + half, quad.y, half),
      createQuadNode(quad.x, quad.y + half, half),
      createQuadNode(quad.x + half, quad.y + half, half)
    ];
    const existing = quad.body;
    quad.body = null;
    placeIntoChild(quad, existing, depth + 1);
    placeIntoChild(quad, body, depth + 1);
    return;
  }
  placeIntoChild(quad, body, depth + 1);
};
var placeIntoChild = (quad, body, depth) => {
  if (!quad.children)
    return;
  const half = quad.size * 0.5;
  const right = body.x >= quad.x + half ? 1 : 0;
  const bottom = body.y >= quad.y + half ? 2 : 0;
  insertBody(quad.children[right + bottom], body, depth);
};
var buildQuadtree = (nodes) => {
  if (!nodes.length)
    return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX)
      minX = node.x;
    if (node.y < minY)
      minY = node.y;
    if (node.x > maxX)
      maxX = node.x;
    if (node.y > maxY)
      maxY = node.y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 64) + 32;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const root = createQuadNode(cx - span * 0.5, cy - span * 0.5, span);
  for (const node of nodes)
    insertBody(root, node);
  return root;
};

class ForceSimulation {
  nodes = [];
  edges = [];
  nodeMap = new Map;
  alpha = 1;
  alphaMin = 0.002;
  alphaDecay = 0.024;
  alphaTarget = 0;
  velocityDecay = 0.62;
  forces;
  constructor(forces) {
    this.forces = { ...forces };
  }
  setForces(forces, reheat = false) {
    this.forces = { ...forces };
    if (reheat)
      this.reheat(0.65);
  }
  reheat(alpha = 0.85) {
    this.alpha = Math.max(this.alpha, alpha);
  }
  setGraph(graphNodes, graphEdges, options) {
    const preserve = options?.preservePositions !== false;
    const prevMap = preserve ? this.nodeMap : new Map;
    const nextMap = new Map;
    const newNodes = [];
    const pendingNew = [];
    for (let i = 0;i < graphNodes.length; i += 1) {
      const gn = graphNodes[i];
      const prev = prevMap.get(gn.id);
      if (prev) {
        const simNode = {
          id: gn.id,
          radius: gn.radius,
          degree: gn.degree,
          hopDistance: gn.hopDistance,
          x: prev.x,
          y: prev.y,
          vx: prev.vx * 0.5,
          vy: prev.vy * 0.5,
          fx: prev.fx,
          fy: prev.fy
        };
        nextMap.set(gn.id, simNode);
        newNodes.push(simNode);
      } else {
        pendingNew.push(gn);
      }
    }
    const neighborPos = new Map;
    for (const edge of graphEdges) {
      const src = nextMap.get(edge.source);
      const tgt = nextMap.get(edge.target);
      if (src && !nextMap.has(edge.target) && !neighborPos.has(edge.target)) {
        neighborPos.set(edge.target, { x: src.x, y: src.y });
      } else if (tgt && !nextMap.has(edge.source) && !neighborPos.has(edge.source)) {
        neighborPos.set(edge.source, { x: tgt.x, y: tgt.y });
      }
    }
    for (let i = 0;i < pendingNew.length; i += 1) {
      const gn = pendingNew[i];
      const index = newNodes.length;
      const hash = hashStringUnit(gn.id);
      let x;
      let y;
      if (gn.hopDistance === 0) {
        x = 0;
        y = 0;
      } else if (neighborPos.has(gn.id)) {
        const anchor = neighborPos.get(gn.id);
        const angle = hash * Math.PI * 2;
        const dist = 36 + hash * 28;
        x = anchor.x + Math.cos(angle) * dist;
        y = anchor.y + Math.sin(angle) * dist;
      } else {
        const angle = index * GOLDEN_ANGLE + (hash - 0.5) * 0.25;
        const radius = 26 * Math.sqrt(index + 1);
        x = Math.cos(angle) * radius;
        y = Math.sin(angle) * radius;
      }
      const simNode = {
        id: gn.id,
        radius: gn.radius,
        degree: gn.degree,
        hopDistance: gn.hopDistance,
        x,
        y,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null
      };
      nextMap.set(gn.id, simNode);
      newNodes.push(simNode);
    }
    const nextEdges = [];
    for (const ge of graphEdges) {
      const source = nextMap.get(ge.source);
      const target = nextMap.get(ge.target);
      if (source && target && source !== target) {
        nextEdges.push({ id: ge.id, source, target });
      }
    }
    const topologyChanged = pendingNew.length > 0 || prevMap.size !== nextMap.size || this.edges.length !== nextEdges.length;
    this.nodes = newNodes;
    this.edges = nextEdges;
    this.nodeMap = nextMap;
    if (options?.reheatAlpha !== undefined) {
      this.alpha = options.reheatAlpha;
    } else if (topologyChanged || !preserve) {
      this.alpha = Math.max(this.alpha, 0.78);
    }
  }
  pinNode(nodeId, x, y) {
    const node = this.nodeMap.get(nodeId);
    if (!node)
      return;
    node.fx = x;
    node.fy = y;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
  }
  unpinNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (!node)
      return;
    node.fx = null;
    node.fy = null;
  }
  isSettled() {
    return this.alpha < this.alphaMin && this.alphaTarget === 0;
  }
  step() {
    if (this.nodes.length === 0)
      return false;
    if (this.isSettled())
      return false;
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const alpha = this.alpha;
    const centerPull = this.forces.centerForce * 0.048 * alpha;
    if (centerPull > 0) {
      for (const node of this.nodes) {
        const weight = node.hopDistance === 0 ? 2.4 : 1;
        node.vx -= node.x * centerPull * weight;
        node.vy -= node.y * centerPull * weight;
      }
    }
    const repelStrength = this.forces.repelForce * 28 * alpha;
    if (repelStrength > 0) {
      if (this.nodes.length <= QUADTREE_THRESHOLD) {
        this.applyExactRepulsion(repelStrength);
      } else {
        this.applyQuadtreeRepulsion(repelStrength);
      }
    }
    const baseDistance = Math.max(24, this.forces.linkDistance);
    const linkStrength = this.forces.linkForce * 0.38 * alpha;
    if (linkStrength > 0) {
      for (const edge of this.edges) {
        const { source, target } = edge;
        let dx = target.x - source.x;
        let dy = target.y - source.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.001) {
          const jitterAngle = hashStringUnit(edge.id) * Math.PI * 2;
          dx = Math.cos(jitterAngle);
          dy = Math.sin(jitterAngle);
          dist = 1;
        }
        const degreeFactor = 1 / Math.sqrt(Math.max(1, Math.min(source.degree, target.degree)));
        const force = (dist - baseDistance) / dist * linkStrength * degreeFactor;
        const fx = dx * force;
        const fy = dy * force;
        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }
    }
    const maxSpeed = 42;
    for (const node of this.nodes) {
      if (node.fx !== null && node.fy !== null) {
        node.x = node.fx;
        node.y = node.fy;
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= this.velocityDecay;
      node.vy *= this.velocityDecay;
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > maxSpeed) {
        const scale = maxSpeed / speed;
        node.vx *= scale;
        node.vy *= scale;
      }
      node.x += node.vx;
      node.y += node.vy;
    }
    return !this.isSettled();
  }
  tick(iterations) {
    for (let i = 0;i < iterations; i += 1) {
      if (!this.step())
        break;
    }
  }
  applyExactRepulsion(repelStrength) {
    const count = this.nodes.length;
    for (let i = 0;i < count; i += 1) {
      const a = this.nodes[i];
      for (let j = i + 1;j < count; j += 1) {
        const b = this.nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.01) {
          const angle = hashStringUnit(`${a.id}:${b.id}`) * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distSq = 1;
        }
        const minDist = a.radius + b.radius + 10;
        const dist = Math.sqrt(distSq);
        const clampedSq = Math.max(distSq, 25);
        let push = repelStrength / clampedSq;
        if (dist < minDist) {
          push += (minDist - dist) / dist * 0.35;
        }
        const fx = dx * push;
        const fy = dy * push;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
  }
  applyQuadtreeRepulsion(repelStrength) {
    const tree = buildQuadtree(this.nodes);
    if (!tree)
      return;
    for (const node of this.nodes) {
      this.accumulateQuadForce(tree, node, repelStrength);
    }
  }
  accumulateQuadForce(quad, node, repelStrength) {
    if (quad.mass === 0)
      return;
    if (quad.body === node && !quad.children)
      return;
    let dx = quad.cx - node.x;
    let dy = quad.cy - node.y;
    let distSq = dx * dx + dy * dy;
    const dist = Math.sqrt(distSq);
    if (!quad.children || quad.size / Math.max(dist, 1) < BARNES_HUT_THETA) {
      if (distSq < 0.01) {
        const angle = hashStringUnit(node.id) * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distSq = 1;
      }
      const clampedSq = Math.max(distSq, 25);
      let push = repelStrength * quad.mass / clampedSq;
      if (quad.body && quad.body !== node) {
        const minDist = node.radius + quad.body.radius + 10;
        if (dist > 0.001 && dist < minDist) {
          push += (minDist - dist) / dist * 0.35;
        }
      }
      node.vx -= dx * push;
      node.vy -= dy * push;
      return;
    }
    for (const child of quad.children) {
      if (child.mass > 0)
        this.accumulateQuadForce(child, node, repelStrength);
    }
  }
}

// src/query-engine.ts
var tokenizeQuery = (raw) => {
  const tokens = [];
  let current = "";
  let quoteChar = null;
  const flushCurrent = () => {
    if (!current)
      return;
    if (current === "OR") {
      tokens.push({ kind: "or" });
    } else {
      tokens.push({ kind: "word", value: current });
    }
    current = "";
  };
  for (let i = 0;i < raw.length; i += 1) {
    const ch = raw[i];
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
var parseTerm = (rawToken) => {
  let token = rawToken.trim();
  if (!token)
    return null;
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
    if (!value)
      return null;
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
var matchTerm = (node, term) => {
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
    if (value === "pinned")
      return node.isPinned;
    if (value === "orphan")
      return node.degree === 0;
    if (value === "unresolved")
      return node.nodeType === "unresolved";
    if (value === "tag")
      return node.nodeType === "tag";
    if (value === "attachment")
      return node.nodeType === "attachment";
    if (value === "note")
      return node.nodeType === "note";
    return false;
  }
  const haystack = [
    node.label,
    node.notebookPath ?? "",
    node.tags.join(" "),
    node.excerpt,
    node.rawId
  ].join(`
`).toLocaleLowerCase();
  return haystack.includes(value);
};
var compileGraphQuery = (raw) => {
  const trimmed = raw.trim();
  if (!trimmed)
    return null;
  const tokens = tokenizeQuery(trimmed);
  if (!tokens.length)
    return null;
  let cursor = 0;
  const parseOr = () => {
    const branches = [];
    const first = parseAnd();
    if (first)
      branches.push(first);
    while (cursor < tokens.length && tokens[cursor]?.kind === "or") {
      cursor += 1;
      const next = parseAnd();
      if (next)
        branches.push(next);
    }
    if (!branches.length)
      return null;
    if (branches.length === 1)
      return branches[0];
    return (node) => branches.some((branch) => branch(node));
  };
  const parseAnd = () => {
    const clauses = [];
    while (cursor < tokens.length) {
      const peek = tokens[cursor];
      if (peek.kind === "or" || peek.kind === "rparen")
        break;
      const atom = parseAtom();
      if (atom)
        clauses.push(atom);
    }
    if (!clauses.length)
      return null;
    if (clauses.length === 1)
      return clauses[0];
    return (node) => clauses.every((clause) => clause(node));
  };
  const parseAtom = () => {
    const token = tokens[cursor];
    if (!token)
      return null;
    if (token.kind === "lparen") {
      cursor += 1;
      const inner = parseOr();
      if (tokens[cursor]?.kind === "rparen")
        cursor += 1;
      if (!inner)
        return null;
      return token.negated ? (node) => !inner(node) : inner;
    }
    if (token.kind === "word") {
      cursor += 1;
      const term = parseTerm(token.value);
      if (!term)
        return null;
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
var matchesExcludedPatterns = (node, rawPatterns) => {
  const trimmed = rawPatterns.trim();
  if (!trimmed)
    return false;
  const parts = trimmed.split(/[,\n]+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const matcher = compileGraphQuery(part);
    if (matcher && matcher(node))
      return true;
  }
  return false;
};

// src/graph-builder.ts
var buildNotebookPaths = (notebooks) => {
  const byId = new Map(notebooks.map((notebook) => [notebook.id, notebook]));
  const cache = new Map;
  const resolve = (notebookId) => {
    const existing = cache.get(notebookId);
    if (existing !== undefined)
      return existing;
    const parts = [];
    const seen = new Set;
    let currentId = notebookId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const nb = byId.get(currentId);
      if (!nb)
        break;
      parts.unshift(nb.name);
      currentId = nb.parentId;
    }
    const path = parts.join("/");
    cache.set(notebookId, path);
    return path;
  };
  for (const nb of notebooks)
    resolve(nb.id);
  return cache;
};
var normalizeWikiKey = (value) => value.trim().replace(/^\/+|\/+$/g, "").toLocaleLowerCase();
var noteNodeId = (noteId) => `note:${noteId}`;
var unresolvedNodeId = (key) => `unresolved:${key}`;
var tagNodeId = (tag) => `tag:${tag.toLocaleLowerCase()}`;
var attachmentNodeId = (resourceId) => `attachment:${resourceId}`;
var buildGraphData = ({
  notes,
  notebooks,
  attachments,
  state,
  untitledLabel
}) => {
  const notebookPaths = buildNotebookPaths(notebooks);
  const notesById = new Map;
  const pathTitleIndex = new Map;
  const titleIndex = new Map;
  const sortedNotes = [...notes].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const note of sortedNotes) {
    notesById.set(note.id, note);
    const title = (note.title ?? "").trim();
    if (!title)
      continue;
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
  const resolveWikiTarget = (rawTarget, sourceNotebookId) => {
    const normalized = normalizeWikiKey(rawTarget);
    if (!normalized)
      return null;
    if (notesById.has(rawTarget.trim()))
      return notesById.get(rawTarget.trim());
    const byFullPath = pathTitleIndex.get(normalized);
    if (byFullPath?.length)
      return byFullPath[0];
    const byTitle = titleIndex.get(normalized);
    if (byTitle?.length) {
      const sameNotebook = byTitle.find((candidate) => candidate.notebookId === sourceNotebookId);
      return sameNotebook ?? byTitle[0];
    }
    const basename = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : "";
    if (basename) {
      const byBase = titleIndex.get(basename);
      if (byBase?.length)
        return byBase[0];
    }
    return null;
  };
  const rawNodes = new Map;
  const rawEdges = new Map;
  const ensureEdge = (source, target, kind, label) => {
    if (source === target)
      return;
    const edgeKey = `${source}->${target}:${kind}`;
    if (!rawEdges.has(edgeKey)) {
      rawEdges.set(edgeKey, {
        id: edgeKey,
        source,
        target,
        kind,
        ...label ? { label } : {}
      });
    }
  };
  for (const note of sortedNotes) {
    const mergedTags = new Map;
    for (const tag of [...note.tags, ...note.inlineTags]) {
      const cleaned = tag.trim().replace(/^#/, "");
      if (!cleaned)
        continue;
      const lower = cleaned.toLocaleLowerCase();
      if (!mergedTags.has(lower))
        mergedTags.set(lower, cleaned);
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
      radius: 5
    });
  }
  for (const note of sortedNotes) {
    const sourceId = noteNodeId(note.id);
    const sourceNode = rawNodes.get(sourceId);
    if (!sourceNode)
      continue;
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
            radius: 4
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
            radius: 4
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
            radius: 4
          });
        }
        ensureEdge(sourceId, tId, "tag");
      }
    }
  }
  if (state.filters.showAttachments) {
    for (const resource of attachments) {
      const parentId = noteNodeId(resource.noteId);
      if (!rawNodes.has(parentId))
        continue;
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
          url: resource.url
        });
      }
      ensureEdge(parentId, attId, "attachment");
    }
  }
  computeDegrees(rawNodes, [...rawEdges.values()]);
  if (state.filters.excludedPatterns.trim()) {
    for (const [id, node] of rawNodes) {
      if (matchesExcludedPatterns(node, state.filters.excludedPatterns)) {
        rawNodes.delete(id);
      }
    }
  }
  let survivingEdges = [...rawEdges.values()].filter((edge) => rawNodes.has(edge.source) && rawNodes.has(edge.target));
  computeDegrees(rawNodes, survivingEdges);
  let activeFocusNoteId = null;
  if (state.mode === "local") {
    const focusKey = state.focusNoteId ? noteNodeId(state.focusNoteId) : null;
    if (focusKey && rawNodes.has(focusKey)) {
      activeFocusNoteId = state.focusNoteId;
      const depthLimit = Math.min(Math.max(Math.round(state.localDepth || 1), 1), 5);
      const hopById = collectLocalNeighborhood(focusKey, survivingEdges, depthLimit, state.localDirection);
      for (const [id, node] of rawNodes) {
        const hop = hopById.get(id);
        if (hop === undefined) {
          rawNodes.delete(id);
        } else {
          node.hopDistance = hop;
        }
      }
      survivingEdges = survivingEdges.filter((edge) => rawNodes.has(edge.source) && rawNodes.has(edge.target));
      computeDegrees(rawNodes, survivingEdges);
    } else {
      rawNodes.clear();
      survivingEdges = [];
    }
  }
  const searchMatcher = compileGraphQuery(state.filters.search);
  if (searchMatcher) {
    for (const [id, node] of rawNodes) {
      if (state.mode === "local" && node.hopDistance === 0)
        continue;
      if (!searchMatcher(node))
        rawNodes.delete(id);
    }
    survivingEdges = survivingEdges.filter((edge) => rawNodes.has(edge.source) && rawNodes.has(edge.target));
    computeDegrees(rawNodes, survivingEdges);
  }
  if (!state.filters.showOrphans) {
    for (const [id, node] of rawNodes) {
      if (state.mode === "local" && node.hopDistance === 0)
        continue;
      if (node.degree === 0)
        rawNodes.delete(id);
    }
    survivingEdges = survivingEdges.filter((edge) => rawNodes.has(edge.source) && rawNodes.has(edge.target));
    computeDegrees(rawNodes, survivingEdges);
  }
  const compiledGroups = compileColorGroups(state.groups);
  const scale = Math.min(Math.max(state.display.nodeSize, 0.4), 3);
  const neighborsById = new Map;
  for (const node of rawNodes.values()) {
    neighborsById.set(node.id, new Set);
    const baseRadius = node.nodeType === "note" ? 5.2 : node.nodeType === "tag" ? 4.4 : 4;
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
    activeFocusNoteId
  };
};
var computeDegrees = (nodes, edges) => {
  for (const node of nodes.values()) {
    node.inDegree = 0;
    node.outDegree = 0;
    node.degree = 0;
  }
  for (const edge of edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target)
      continue;
    source.outDegree += 1;
    source.degree += 1;
    target.inDegree += 1;
    target.degree += 1;
  }
};
var collectLocalNeighborhood = (focusId, edges, depthLimit, direction) => {
  const adjacency = new Map;
  const addAdj = (from, to) => {
    const list = adjacency.get(from);
    if (list)
      list.push(to);
    else
      adjacency.set(from, [to]);
  };
  for (const edge of edges) {
    if (direction === "both" || direction === "outgoing") {
      addAdj(edge.source, edge.target);
    }
    if (direction === "both" || direction === "incoming") {
      addAdj(edge.target, edge.source);
    }
  }
  const visited = new Map([[focusId, 0]]);
  const queue = [[focusId, 0]];
  let head = 0;
  while (head < queue.length) {
    const [currentId, dist] = queue[head++];
    if (dist >= depthLimit)
      continue;
    for (const nextId of adjacency.get(currentId) ?? []) {
      if (!visited.has(nextId)) {
        visited.set(nextId, dist + 1);
        queue.push([nextId, dist + 1]);
      }
    }
  }
  return visited;
};
var compileColorGroups = (groups) => {
  const result = [];
  for (const group of groups) {
    if (!group.enabled || !group.query.trim())
      continue;
    const matcher = compileGraphQuery(group.query);
    if (matcher) {
      result.push({ id: group.id, color: group.color, match: matcher });
    }
  }
  return result;
};

// src/types.ts
var DEFAULT_GROUP_COLORS = [
  "#16a06e",
  "#2563eb",
  "#d97706",
  "#db2777",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#65a30d"
];
var DEFAULT_GRAPH_FILTERS = {
  search: "",
  showTags: false,
  showAttachments: false,
  existingFilesOnly: false,
  showOrphans: true,
  excludedPatterns: ""
};
var DEFAULT_GRAPH_DISPLAY = {
  showArrows: false,
  textFadeThreshold: 0,
  nodeSize: 1,
  linkThickness: 1
};
var DEFAULT_GRAPH_FORCES = {
  centerForce: 0.45,
  repelForce: 10,
  linkForce: 0.8,
  linkDistance: 120
};

// src/panel-ui.ts
var UI_PREFS_STORAGE_KEY = "graph-view-ui-prefs-v1";
var nextId = () => `grp_${Math.random().toString(36).slice(2, 9)}`;
var clamp = (value, min, max) => Math.min(Math.max(value, min), max);
var appendNodes = (parent, ...children) => {
  for (const child of children)
    parent.appendChild(child);
};
var readBooleanSetting = async (context, key, fallback) => {
  try {
    const val = await context.settings.get(key);
    return typeof val === "boolean" ? val : fallback;
  } catch {
    return fallback;
  }
};
var readNumberSetting = async (context, key, fallback, min, max) => {
  try {
    const val = await context.settings.get(key);
    return typeof val === "number" && Number.isFinite(val) ? clamp(val, min, max) : fallback;
  } catch {
    return fallback;
  }
};
var readStringSetting = async (context, key, fallback) => {
  try {
    const val = await context.settings.get(key);
    return typeof val === "string" ? val : fallback;
  } catch {
    return fallback;
  }
};
var mountGraphViewPanel = async ({
  context,
  indexer,
  mountContext,
  container
}) => {
  const copy = getGraphCopy();
  const abortController = new AbortController;
  const instanceId = `gv_${Math.random().toString(36).slice(2, 7)}`;
  const panelState = mountContext.state && typeof mountContext.state === "object" && !Array.isArray(mountContext.state) ? mountContext.state : {};
  const [
    defaultMode,
    localDepth,
    maxNotes,
    showTags,
    showAttachments,
    existingFilesOnly,
    showOrphans,
    excludedPatterns,
    showArrows,
    prefs,
    activeEditorNoteId
  ] = await Promise.all([
    readStringSetting(context, "general.default-mode", "global"),
    readNumberSetting(context, "general.local-depth", 1, 1, 5),
    readNumberSetting(context, "general.max-notes", 1000, 50, 5000),
    readBooleanSetting(context, "filters.show-tags", DEFAULT_GRAPH_FILTERS.showTags),
    readBooleanSetting(context, "filters.show-attachments", DEFAULT_GRAPH_FILTERS.showAttachments),
    readBooleanSetting(context, "filters.existing-files-only", DEFAULT_GRAPH_FILTERS.existingFilesOnly),
    readBooleanSetting(context, "filters.show-orphans", DEFAULT_GRAPH_FILTERS.showOrphans),
    readStringSetting(context, "filters.excluded-patterns", DEFAULT_GRAPH_FILTERS.excludedPatterns),
    readBooleanSetting(context, "display.show-arrows", DEFAULT_GRAPH_DISPLAY.showArrows),
    context.storage.get(UI_PREFS_STORAGE_KEY).catch(() => null),
    indexer.resolveActiveNoteId()
  ]);
  if (abortController.signal.aborted)
    return () => {
      return;
    };
  const initialMode = panelState.mode === "local" || panelState.mode !== "global" && defaultMode === "local" ? "local" : "global";
  const initialFocusNoteId = typeof panelState.focusNoteId === "string" && panelState.focusNoteId ? panelState.focusNoteId : activeEditorNoteId;
  const state = {
    mode: initialMode,
    focusNoteId: initialFocusNoteId,
    localDepth,
    localDirection: prefs?.localDirection === "outgoing" || prefs?.localDirection === "incoming" ? prefs.localDirection : "both",
    maxNotes,
    filters: {
      search: "",
      showTags,
      showAttachments,
      existingFilesOnly,
      showOrphans,
      excludedPatterns
    },
    groups: Array.isArray(prefs?.groups) ? prefs.groups.map((grp) => ({
      id: typeof grp.id === "string" ? grp.id : nextId(),
      query: typeof grp.query === "string" ? grp.query : "",
      color: typeof grp.color === "string" ? grp.color : DEFAULT_GROUP_COLORS[0],
      enabled: grp.enabled !== false
    })) : [],
    display: {
      showArrows,
      textFadeThreshold: typeof prefs?.display?.textFadeThreshold === "number" ? clamp(prefs.display.textFadeThreshold, -2, 2) : DEFAULT_GRAPH_DISPLAY.textFadeThreshold,
      nodeSize: typeof prefs?.display?.nodeSize === "number" ? clamp(prefs.display.nodeSize, 0.5, 2.5) : DEFAULT_GRAPH_DISPLAY.nodeSize,
      linkThickness: typeof prefs?.display?.linkThickness === "number" ? clamp(prefs.display.linkThickness, 0.4, 3) : DEFAULT_GRAPH_DISPLAY.linkThickness
    },
    forces: {
      centerForce: typeof prefs?.forces?.centerForce === "number" ? clamp(prefs.forces.centerForce, 0, 1) : DEFAULT_GRAPH_FORCES.centerForce,
      repelForce: typeof prefs?.forces?.repelForce === "number" ? clamp(prefs.forces.repelForce, 1, 22) : DEFAULT_GRAPH_FORCES.repelForce,
      linkForce: typeof prefs?.forces?.linkForce === "number" ? clamp(prefs.forces.linkForce, 0.1, 2) : DEFAULT_GRAPH_FORCES.linkForce,
      linkDistance: typeof prefs?.forces?.linkDistance === "number" ? clamp(prefs.forces.linkDistance, 40, 280) : DEFAULT_GRAPH_FORCES.linkDistance
    }
  };
  let sidebarOpen = prefs?.sidebarOpen !== false;
  let isLoading = true;
  let currentGraph = null;
  let hoveredNode = null;
  let timelapseRunning = false;
  let savePrefsTimer = null;
  const schedulePersistUiPrefs = () => {
    if (savePrefsTimer)
      clearTimeout(savePrefsTimer);
    savePrefsTimer = setTimeout(() => {
      context.storage.set(UI_PREFS_STORAGE_KEY, {
        localDirection: state.localDirection,
        sidebarOpen,
        groups: state.groups,
        display: state.display,
        forces: state.forces
      }).catch(() => {
        return;
      });
    }, 180);
  };
  const root = document.createElement("div");
  root.className = "ee-gv-root";
  const stage = document.createElement("div");
  stage.className = "ee-gv-stage";
  const helpId = `${instanceId}-keyboard-help`;
  const canvas = document.createElement("canvas");
  canvas.className = "ee-gv-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", copy.canvasAriaLabel);
  canvas.setAttribute("aria-describedby", helpId);
  const hudTopLeft = document.createElement("div");
  hudTopLeft.className = "ee-gv-hud-top-left";
  const statsPill = document.createElement("div");
  statsPill.className = "ee-gv-pill";
  statsPill.setAttribute("aria-live", "polite");
  statsPill.textContent = copy.loadingLabel;
  const timelapseBar = document.createElement("div");
  timelapseBar.className = "ee-gv-timelapse-bar";
  timelapseBar.hidden = true;
  const timelapseProgressEl = document.createElement("progress");
  timelapseProgressEl.max = 100;
  timelapseProgressEl.value = 0;
  const timelapseLabel = document.createElement("span");
  appendNodes(timelapseBar, timelapseProgressEl, timelapseLabel);
  appendNodes(hudTopLeft, statsPill, timelapseBar);
  const hudBottomLeft = document.createElement("div");
  hudBottomLeft.className = "ee-gv-hud-bottom-left";
  const hudBottomRight = document.createElement("div");
  hudBottomRight.className = "ee-gv-hud-bottom-right";
  const emptyOverlay = document.createElement("div");
  emptyOverlay.className = "ee-gv-empty-overlay";
  emptyOverlay.hidden = true;
  const tooltip = document.createElement("div");
  tooltip.className = "ee-gv-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.id = `${instanceId}-tooltip`;
  tooltip.hidden = true;
  const showTooltip = (target, text) => {
    tooltip.textContent = text;
    tooltip.hidden = false;
    target.setAttribute("aria-describedby", tooltip.id);
    const rect = target.getBoundingClientRect?.();
    if (!rect)
      return;
    tooltip.style.left = `${Math.max(8, rect.left - tooltip.offsetWidth - 8)}px`;
    tooltip.style.top = `${Math.max(8, rect.top + (rect.height - tooltip.offsetHeight) * 0.5)}px`;
  };
  const hideTooltip = (target) => {
    tooltip.hidden = true;
    target?.removeAttribute("aria-describedby");
  };
  const attachTooltip = (button, label) => {
    button.setAttribute("aria-label", label);
    button.addEventListener("pointerenter", () => showTooltip(button, label));
    button.addEventListener("pointerleave", () => hideTooltip(button));
    button.addEventListener("focusin", () => showTooltip(button, label));
    button.addEventListener("focusout", () => hideTooltip(button));
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape")
        hideTooltip(button);
    });
  };
  const makeHudButton = (glyph, label, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ee-gv-icon-btn";
    btn.textContent = glyph;
    attachTooltip(btn, label);
    btn.addEventListener("click", onClick);
    return btn;
  };
  const sidebar = document.createElement("aside");
  sidebar.className = "ee-gv-sidebar";
  sidebar.setAttribute("aria-label", copy.sidebarAriaLabel);
  sidebar.hidden = !sidebarOpen;
  appendNodes(stage, canvas, hudTopLeft, hudBottomLeft, hudBottomRight, emptyOverlay);
  appendNodes(root, stage, sidebar, tooltip);
  appendNodes(container, root);
  const simulation = new ForceSimulation(state.forces);
  const openNoteFromGraph = async (noteId) => {
    try {
      await context.ui.openNote(noteId);
      await mountContext.requestClose();
    } catch (error) {
      context.ui.showNotice(error instanceof Error ? error.message : String(error));
    }
  };
  const focusLocalNote = (noteId) => {
    state.mode = "local";
    state.focusNoteId = noteId;
    syncShell();
    rebuildGraph({ fitIfFirst: true });
    renderer.fitToView();
  };
  const handleActivateNode = (node) => {
    if (node.nodeType === "note") {
      openNoteFromGraph(node.rawId);
      return;
    }
    if (node.nodeType === "unresolved") {
      context.ui.showNotice(copy.noticeUnresolvedNote);
      return;
    }
    if (node.nodeType === "tag") {
      state.filters.search = `tag:#${node.rawId}`;
      syncShell();
      rebuildGraph({ fitIfFirst: true });
      return;
    }
    if (node.nodeType === "attachment" && currentGraph) {
      for (const edge of currentGraph.edges) {
        if (edge.target === node.id && edge.source.startsWith("note:")) {
          openNoteFromGraph(edge.source.slice(5));
          return;
        }
      }
    }
  };
  const renderPreviewCard = (node) => {
    hoveredNode = node;
    hudBottomLeft.replaceChildren();
    if (!node)
      return;
    const card = document.createElement("div");
    card.className = "ee-gv-preview-card";
    const header = document.createElement("div");
    header.className = "ee-gv-preview-header";
    const title = document.createElement("span");
    title.className = "ee-gv-preview-title";
    title.textContent = node.label;
    const badgeText = node.nodeType === "unresolved" ? copy.unresolvedBadge : node.nodeType === "tag" ? copy.tagBadge : node.nodeType === "attachment" ? copy.attachmentBadge : node.notebookPath || node.noteKind || "text";
    const badge = document.createElement("span");
    badge.className = "ee-gv-badge";
    badge.textContent = badgeText;
    appendNodes(header, title, badge);
    const meta = document.createElement("div");
    meta.className = "ee-gv-preview-meta";
    meta.textContent = copy.connectionsLabel(node.inDegree, node.outDegree);
    appendNodes(card, header, meta);
    if (node.excerpt) {
      const excerpt = document.createElement("div");
      excerpt.className = "ee-gv-preview-excerpt";
      excerpt.textContent = node.excerpt;
      appendNodes(card, excerpt);
    }
    if (node.nodeType === "note") {
      const actions = document.createElement("div");
      actions.className = "ee-gv-preview-actions";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "ee-gv-btn ee-gv-btn-primary";
      openBtn.textContent = copy.openNoteAction;
      openBtn.addEventListener("click", () => void openNoteFromGraph(node.rawId));
      const localBtn = document.createElement("button");
      localBtn.type = "button";
      localBtn.className = "ee-gv-btn";
      localBtn.textContent = copy.focusLocalAction;
      localBtn.addEventListener("click", () => focusLocalNote(node.rawId));
      appendNodes(actions, openBtn, localBtn);
      appendNodes(card, actions);
    }
    appendNodes(hudBottomLeft, card);
  };
  const renderer = new GraphCanvasRenderer({
    rootElement: root,
    canvas,
    simulation,
    onHoverNode: renderPreviewCard,
    onActivateNode: handleActivateNode,
    onFocusLocalNode: (node) => {
      if (node.nodeType === "note")
        focusLocalNote(node.rawId);
    },
    onTimelapseState: ({ running, current, total, dateLabel }) => {
      timelapseRunning = running;
      timelapseBar.hidden = !running;
      if (running && total > 0) {
        timelapseProgressEl.max = total;
        timelapseProgressEl.value = current;
        timelapseLabel.textContent = copy.timelapseProgress(current, total, dateLabel);
      }
      if (animateSidebarBtn) {
        animateSidebarBtn.textContent = running ? copy.actionStopAnimate : copy.actionAnimate;
      }
      syncShell();
    }
  });
  appendNodes(hudBottomRight, makeHudButton("+", copy.actionZoomIn, () => renderer.zoomBy(1.25)), makeHudButton("−", copy.actionZoomOut, () => renderer.zoomBy(1 / 1.25)), makeHudButton("⌖", copy.actionFit, () => renderer.fitToView()), makeHudButton("↻", copy.actionReheat, () => {
    simulation.reheat(0.95);
    renderer.scheduleFrame();
  }));
  let localSectionEl;
  let localSelectEl;
  let groupsListEl;
  let nodeListEl;
  let nodesSummaryLabelEl;
  let excludedInputRef = null;
  let animateSidebarBtn = null;
  const syncLocalSelectOptions = () => {
    const snapshot = indexer.getSnapshot();
    const sorted = [...snapshot.notes].sort((a, b) => (a.title || a.excerpt || copy.untitledNote).localeCompare(b.title || b.excerpt || copy.untitledNote));
    const targetFocusId = state.focusNoteId ?? "";
    let matchedOption = false;
    localSelectEl.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = copy.localTargetPlaceholder;
    placeholder.selected = targetFocusId === "";
    appendNodes(localSelectEl, placeholder);
    for (const note of sorted) {
      const opt = document.createElement("option");
      opt.value = note.id;
      opt.textContent = note.title?.trim() || note.excerpt?.trim() || copy.untitledNote;
      const isSelected = note.id === targetFocusId;
      opt.selected = isSelected;
      if (isSelected)
        matchedOption = true;
      appendNodes(localSelectEl, opt);
    }
    if (!matchedOption)
      placeholder.selected = true;
    localSectionEl.hidden = state.mode !== "local";
  };
  const renderVisibleNodesList = (graph) => {
    nodesSummaryLabelEl.textContent = `${copy.sectionNodes} (${graph.nodes.length})`;
    nodeListEl.replaceChildren();
    const topNodes = [...graph.nodes].sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label)).slice(0, 80);
    for (const node of topNodes) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ee-gv-node-item-btn";
      btn.addEventListener("click", () => {
        renderer.focusNodeById(node.id);
        renderPreviewCard(node);
      });
      btn.addEventListener("dblclick", () => handleActivateNode(node));
      const dot = document.createElement("span");
      dot.className = "ee-gv-node-item-dot";
      dot.style.backgroundColor = node.groupColor ?? (node.nodeType === "tag" ? "#0d9488" : node.nodeType === "attachment" ? "#6366f1" : node.nodeType === "unresolved" ? "#94a3b8" : "#16a06e");
      const label = document.createElement("span");
      label.className = "ee-gv-node-item-label";
      label.textContent = node.label;
      const deg = document.createElement("span");
      deg.className = "ee-gv-node-item-deg";
      deg.textContent = String(node.degree);
      appendNodes(btn, dot, label, deg);
      appendNodes(li, btn);
      appendNodes(nodeListEl, li);
    }
  };
  const updateEmptyOverlay = (graph) => {
    emptyOverlay.replaceChildren();
    if (isLoading) {
      emptyOverlay.hidden = true;
      return;
    }
    if (graph.nodes.length > 0) {
      emptyOverlay.hidden = true;
      return;
    }
    emptyOverlay.hidden = false;
    const titleEl = document.createElement("p");
    titleEl.className = "ee-gv-empty-title";
    const descEl = document.createElement("p");
    descEl.className = "ee-gv-empty-desc";
    if (graph.totalIndexedNotes === 0) {
      titleEl.textContent = copy.emptyTitle;
      descEl.textContent = copy.emptyDescription;
      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "ee-gv-btn";
      refreshBtn.textContent = copy.actionRefresh;
      refreshBtn.addEventListener("click", () => void syncWorkspace(true));
      appendNodes(emptyOverlay, titleEl, descEl, refreshBtn);
      return;
    }
    if (state.mode === "local" && !graph.activeFocusNoteId) {
      titleEl.textContent = copy.sectionLocalTarget;
      descEl.textContent = copy.localNoTarget;
      appendNodes(emptyOverlay, titleEl, descEl);
      return;
    }
    titleEl.textContent = copy.emptyFilteredTitle;
    descEl.textContent = copy.emptyFilteredDescription;
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "ee-gv-btn";
    resetBtn.textContent = copy.emptyResetAction;
    resetBtn.addEventListener("click", () => {
      state.filters.search = "";
      state.filters.excludedPatterns = "";
      state.filters.showOrphans = true;
      state.filters.existingFilesOnly = false;
      if (excludedInputRef)
        excludedInputRef.value = "";
      syncSidebarInputs();
      syncShell();
      rebuildGraph({ fitIfFirst: true });
    });
    appendNodes(emptyOverlay, titleEl, descEl, resetBtn);
  };
  const rebuildGraph = (options) => {
    const snapshot = indexer.getSnapshot();
    const graph = buildGraphData({
      notes: snapshot.notes,
      notebooks: snapshot.notebooks,
      attachments: snapshot.attachments,
      state,
      untitledLabel: copy.untitledNote
    });
    currentGraph = graph;
    simulation.setForces(state.forces);
    simulation.setGraph(graph.nodes, graph.edges, {
      preservePositions: options?.preservePositions
    });
    renderer.setGraphData(graph, state.display, { fitIfFirst: options?.fitIfFirst });
    statsPill.textContent = copy.statsLabel(graph.nodes.length, graph.edges.length);
    if (hoveredNode) {
      renderPreviewCard(graph.nodeById.get(hoveredNode.id) ?? null);
    }
    syncLocalSelectOptions();
    renderVisibleNodesList(graph);
    updateEmptyOverlay(graph);
  };
  const syncShell = () => {
    const toolbar = [
      {
        type: "tabs",
        key: "mode",
        value: state.mode,
        options: [
          { value: "global", label: copy.tabGlobal },
          { value: "local", label: copy.tabLocal }
        ]
      },
      {
        type: "search",
        key: "search",
        placeholder: copy.searchPlaceholder,
        value: state.filters.search
      }
    ];
    if (state.mode === "local") {
      toolbar.push({
        type: "select",
        key: "localDepth",
        label: copy.depthLabel,
        value: String(state.localDepth),
        options: [1, 2, 3, 4, 5].map((depth) => ({ value: String(depth), label: String(depth) }))
      }, {
        type: "select",
        key: "localDirection",
        label: copy.directionLabel,
        value: state.localDirection,
        options: [
          { value: "both", label: copy.directionBoth },
          { value: "outgoing", label: copy.directionOutgoing },
          { value: "incoming", label: copy.directionIncoming }
        ]
      });
    }
    mountContext.shell.set({
      header: {
        title: copy.panelTitle,
        description: null,
        actions: [
          {
            id: "animate",
            label: timelapseRunning ? copy.actionStopAnimate : copy.actionAnimate,
            variant: timelapseRunning ? "primary" : "default"
          },
          { id: "fit", label: copy.actionFit },
          { id: "refresh", label: copy.actionRefresh },
          {
            id: "controls",
            label: copy.actionControls,
            variant: sidebarOpen ? "primary" : "default"
          }
        ]
      },
      toolbar,
      onAction(actionId) {
        if (actionId === "animate") {
          renderer.toggleTimelapse();
          return;
        }
        if (actionId === "fit") {
          renderer.fitToView();
          return;
        }
        if (actionId === "refresh") {
          syncWorkspace(true);
          return;
        }
        if (actionId === "controls") {
          sidebarOpen = !sidebarOpen;
          sidebar.hidden = !sidebarOpen;
          schedulePersistUiPrefs();
          syncShell();
        }
      },
      onChange(key, value) {
        if (key === "mode") {
          const nextMode = value === "local" ? "local" : "global";
          state.mode = nextMode;
          if (nextMode === "local" && !state.focusNoteId) {
            const firstNote = indexer.getSnapshot().notes[0];
            if (firstNote)
              state.focusNoteId = firstNote.id;
          }
          syncShell();
          rebuildGraph({ fitIfFirst: true, preservePositions: false });
          renderer.fitToView();
          return;
        }
        if (key === "search") {
          state.filters.search = value;
          syncShell();
          rebuildGraph();
          return;
        }
        if (key === "localDepth") {
          state.localDepth = clamp(Number(value) || 1, 1, 5);
          syncShell();
          rebuildGraph({ fitIfFirst: true });
          return;
        }
        if (key === "localDirection") {
          state.localDirection = value === "outgoing" || value === "incoming" ? value : "both";
          schedulePersistUiPrefs();
          syncShell();
          rebuildGraph({ fitIfFirst: true });
        }
      }
    });
  };
  const createSection = (titleText, openByDefault) => {
    const details = document.createElement("details");
    details.className = "ee-gv-section";
    details.open = openByDefault;
    const summary = document.createElement("summary");
    summary.className = "ee-gv-summary";
    const span = document.createElement("span");
    span.textContent = titleText;
    appendNodes(summary, span);
    const body = document.createElement("div");
    body.className = "ee-gv-section-body";
    appendNodes(details, summary, body);
    return { details, body, summaryLabel: span };
  };
  const makeCheckbox = (idSuffix, labelText, initial, onToggle) => {
    const id = `${instanceId}-${idSuffix}`;
    const label = document.createElement("label");
    label.className = "ee-gv-checkbox";
    label.setAttribute("for", id);
    const textSpan = document.createElement("span");
    textSpan.textContent = labelText;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = initial;
    input.addEventListener("change", () => onToggle(input.checked));
    appendNodes(label, textSpan, input);
    return { label, input };
  };
  const makeSlider = (idSuffix, labelText, min, max, step, initial, formatValue, onInput) => {
    const id = `${instanceId}-${idSuffix}`;
    const wrap = document.createElement("div");
    wrap.className = "ee-gv-field";
    const labelRow = document.createElement("label");
    labelRow.className = "ee-gv-field-label";
    labelRow.setAttribute("for", id);
    const titleSpan = document.createElement("span");
    titleSpan.textContent = labelText;
    const valueSpan = document.createElement("span");
    valueSpan.className = "ee-gv-field-value";
    valueSpan.textContent = formatValue(initial);
    appendNodes(labelRow, titleSpan, valueSpan);
    const range = document.createElement("input");
    range.type = "range";
    range.className = "ee-gv-range";
    range.id = id;
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(initial);
    range.addEventListener("input", () => {
      const next = Number(range.value);
      valueSpan.textContent = formatValue(next);
      onInput(next);
    });
    appendNodes(wrap, labelRow, range);
    return { wrap, range, valueSpan };
  };
  const localSec = createSection(copy.sectionLocalTarget, true);
  localSectionEl = localSec.details;
  localSectionEl.hidden = state.mode !== "local";
  const localSelectId = `${instanceId}-local-target`;
  const localTargetLabel = document.createElement("label");
  localTargetLabel.className = "ee-gv-field-label";
  localTargetLabel.setAttribute("for", localSelectId);
  localTargetLabel.textContent = copy.localTargetCurrent;
  localSelectEl = document.createElement("select");
  localSelectEl.className = "ee-gv-select";
  localSelectEl.id = localSelectId;
  localSelectEl.addEventListener("change", () => {
    state.focusNoteId = localSelectEl.value || null;
    rebuildGraph({ fitIfFirst: true, preservePositions: false });
    renderer.fitToView();
  });
  appendNodes(localSec.body, localTargetLabel, localSelectEl);
  const filtersSec = createSection(copy.sectionFilters, true);
  const cbTags = makeCheckbox("filter-tags", copy.filterTags, state.filters.showTags, (checked) => {
    state.filters.showTags = checked;
    rebuildGraph();
  });
  const cbAttachments = makeCheckbox("filter-attachments", copy.filterAttachments, state.filters.showAttachments, async (checked) => {
    state.filters.showAttachments = checked;
    if (checked)
      await indexer.ensureAttachmentsLoaded(abortController.signal);
    rebuildGraph();
  });
  const cbExisting = makeCheckbox("filter-existing", copy.filterExistingOnly, state.filters.existingFilesOnly, (checked) => {
    state.filters.existingFilesOnly = checked;
    rebuildGraph();
  });
  const cbOrphans = makeCheckbox("filter-orphans", copy.filterOrphans, state.filters.showOrphans, (checked) => {
    state.filters.showOrphans = checked;
    rebuildGraph();
  });
  const excludedId = `${instanceId}-excluded`;
  const excludedField = document.createElement("div");
  excludedField.className = "ee-gv-field";
  const excludedLabel = document.createElement("label");
  excludedLabel.className = "ee-gv-field-label";
  excludedLabel.setAttribute("for", excludedId);
  excludedLabel.textContent = copy.filterExcluded;
  const excludedInput = document.createElement("input");
  excludedInput.type = "text";
  excludedInput.className = "ee-gv-input";
  excludedInput.id = excludedId;
  excludedInput.placeholder = copy.filterExcludedPlaceholder;
  excludedInput.value = state.filters.excludedPatterns;
  excludedInput.addEventListener("input", () => {
    state.filters.excludedPatterns = excludedInput.value;
    rebuildGraph();
  });
  excludedInputRef = excludedInput;
  appendNodes(excludedField, excludedLabel, excludedInput);
  appendNodes(filtersSec.body, cbTags.label, cbAttachments.label, cbExisting.label, cbOrphans.label, excludedField);
  const groupsSec = createSection(copy.sectionGroups, true);
  groupsListEl = document.createElement("div");
  groupsListEl.className = "ee-gv-field";
  const renderGroupsList = () => {
    groupsListEl.replaceChildren();
    state.groups.forEach((group, index) => {
      const row = document.createElement("div");
      row.className = "ee-gv-group-row";
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.className = "ee-gv-color-input";
      colorInput.value = group.color;
      colorInput.setAttribute("aria-label", `${copy.groupColorLabel} ${index + 1}`);
      colorInput.addEventListener("input", () => {
        group.color = colorInput.value;
        schedulePersistUiPrefs();
        rebuildGraph();
      });
      const queryInput = document.createElement("input");
      queryInput.type = "text";
      queryInput.className = "ee-gv-input";
      queryInput.value = group.query;
      queryInput.placeholder = copy.groupPlaceholder;
      queryInput.setAttribute("aria-label", `${copy.groupPlaceholder} ${index + 1}`);
      queryInput.addEventListener("input", () => {
        group.query = queryInput.value;
        schedulePersistUiPrefs();
        rebuildGraph();
      });
      const actions = document.createElement("div");
      actions.className = "ee-gv-group-actions";
      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "ee-gv-mini-btn";
      upBtn.textContent = "↑";
      upBtn.disabled = index === 0;
      upBtn.setAttribute("aria-label", copy.groupMoveUp);
      upBtn.addEventListener("click", () => {
        if (index === 0)
          return;
        const prev = state.groups[index - 1];
        state.groups[index - 1] = group;
        state.groups[index] = prev;
        schedulePersistUiPrefs();
        renderGroupsList();
        rebuildGraph();
      });
      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "ee-gv-mini-btn";
      downBtn.textContent = "↓";
      downBtn.disabled = index === state.groups.length - 1;
      downBtn.setAttribute("aria-label", copy.groupMoveDown);
      downBtn.addEventListener("click", () => {
        if (index >= state.groups.length - 1)
          return;
        const next = state.groups[index + 1];
        state.groups[index + 1] = group;
        state.groups[index] = next;
        schedulePersistUiPrefs();
        renderGroupsList();
        rebuildGraph();
      });
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ee-gv-mini-btn";
      delBtn.textContent = "×";
      delBtn.setAttribute("aria-label", copy.groupDelete);
      delBtn.addEventListener("click", () => {
        state.groups.splice(index, 1);
        schedulePersistUiPrefs();
        renderGroupsList();
        rebuildGraph();
      });
      appendNodes(actions, upBtn, downBtn, delBtn);
      appendNodes(row, colorInput, queryInput, actions);
      appendNodes(groupsListEl, row);
    });
  };
  const addGroupBtn = document.createElement("button");
  addGroupBtn.type = "button";
  addGroupBtn.className = "ee-gv-btn";
  addGroupBtn.textContent = `+ ${copy.groupAdd}`;
  addGroupBtn.addEventListener("click", () => {
    const color = DEFAULT_GROUP_COLORS[state.groups.length % DEFAULT_GROUP_COLORS.length];
    state.groups.push({ id: nextId(), query: "", color, enabled: true });
    schedulePersistUiPrefs();
    renderGroupsList();
    const lastInput = groupsListEl.querySelector("div:last-child input[type='text']");
    lastInput?.focus();
  });
  renderGroupsList();
  appendNodes(groupsSec.body, groupsListEl, addGroupBtn);
  const displaySec = createSection(copy.sectionDisplay, true);
  const cbArrows = makeCheckbox("display-arrows", copy.displayArrows, state.display.showArrows, (checked) => {
    state.display.showArrows = checked;
    renderer.setDisplay(state.display);
  });
  const slTextFade = makeSlider("display-fade", copy.displayTextFade, -2, 2, 0.1, state.display.textFadeThreshold, (v) => v.toFixed(1), (val) => {
    state.display.textFadeThreshold = val;
    schedulePersistUiPrefs();
    renderer.setDisplay(state.display);
  });
  const slNodeSize = makeSlider("display-nodesize", copy.displayNodeSize, 0.5, 2.5, 0.1, state.display.nodeSize, (v) => `${v.toFixed(1)}×`, (val) => {
    state.display.nodeSize = val;
    schedulePersistUiPrefs();
    rebuildGraph();
  });
  const slLinkThick = makeSlider("display-linkthick", copy.displayLinkThickness, 0.4, 3, 0.1, state.display.linkThickness, (v) => `${v.toFixed(1)}×`, (val) => {
    state.display.linkThickness = val;
    schedulePersistUiPrefs();
    renderer.setDisplay(state.display);
  });
  animateSidebarBtn = document.createElement("button");
  animateSidebarBtn.type = "button";
  animateSidebarBtn.className = "ee-gv-btn";
  animateSidebarBtn.textContent = copy.actionAnimate;
  animateSidebarBtn.addEventListener("click", () => {
    renderer.toggleTimelapse();
    animateSidebarBtn.textContent = renderer.isTimelapseRunning() ? copy.actionStopAnimate : copy.actionAnimate;
  });
  appendNodes(displaySec.body, cbArrows.label, slTextFade.wrap, slNodeSize.wrap, slLinkThick.wrap, animateSidebarBtn);
  const forcesSec = createSection(copy.sectionForces, false);
  const slCenter = makeSlider("force-center", copy.forceCenter, 0, 1, 0.05, state.forces.centerForce, (v) => v.toFixed(2), (val) => {
    state.forces.centerForce = val;
    schedulePersistUiPrefs();
    simulation.setForces(state.forces, true);
    renderer.scheduleFrame();
  });
  const slRepel = makeSlider("force-repel", copy.forceRepel, 1, 22, 0.5, state.forces.repelForce, (v) => v.toFixed(1), (val) => {
    state.forces.repelForce = val;
    schedulePersistUiPrefs();
    simulation.setForces(state.forces, true);
    renderer.scheduleFrame();
  });
  const slLinkForce = makeSlider("force-link", copy.forceLink, 0.1, 2, 0.05, state.forces.linkForce, (v) => v.toFixed(2), (val) => {
    state.forces.linkForce = val;
    schedulePersistUiPrefs();
    simulation.setForces(state.forces, true);
    renderer.scheduleFrame();
  });
  const slDistance = makeSlider("force-distance", copy.forceDistance, 40, 280, 5, state.forces.linkDistance, (v) => `${Math.round(v)}`, (val) => {
    state.forces.linkDistance = val;
    schedulePersistUiPrefs();
    simulation.setForces(state.forces, true);
    renderer.scheduleFrame();
  });
  const resetForcesBtn = document.createElement("button");
  resetForcesBtn.type = "button";
  resetForcesBtn.className = "ee-gv-btn";
  resetForcesBtn.textContent = copy.forcesReset;
  resetForcesBtn.addEventListener("click", () => {
    state.forces = { ...DEFAULT_GRAPH_FORCES };
    slCenter.range.value = String(state.forces.centerForce);
    slCenter.valueSpan.textContent = state.forces.centerForce.toFixed(2);
    slRepel.range.value = String(state.forces.repelForce);
    slRepel.valueSpan.textContent = state.forces.repelForce.toFixed(1);
    slLinkForce.range.value = String(state.forces.linkForce);
    slLinkForce.valueSpan.textContent = state.forces.linkForce.toFixed(2);
    slDistance.range.value = String(state.forces.linkDistance);
    slDistance.valueSpan.textContent = String(Math.round(state.forces.linkDistance));
    schedulePersistUiPrefs();
    simulation.setForces(state.forces, true);
    renderer.scheduleFrame();
  });
  appendNodes(forcesSec.body, slCenter.wrap, slRepel.wrap, slLinkForce.wrap, slDistance.wrap, resetForcesBtn);
  const nodesSec = createSection(copy.sectionNodes, false);
  nodesSummaryLabelEl = nodesSec.summaryLabel;
  nodeListEl = document.createElement("ul");
  nodeListEl.className = "ee-gv-node-list";
  appendNodes(nodesSec.body, nodeListEl);
  const helpHint = document.createElement("p");
  helpHint.className = "ee-gv-help-hint";
  helpHint.id = helpId;
  helpHint.textContent = copy.keyboardHelp;
  const syncSidebarInputs = () => {
    cbTags.input.checked = state.filters.showTags;
    cbAttachments.input.checked = state.filters.showAttachments;
    cbExisting.input.checked = state.filters.existingFilesOnly;
    cbOrphans.input.checked = state.filters.showOrphans;
    cbArrows.input.checked = state.display.showArrows;
    excludedInput.value = state.filters.excludedPatterns;
  };
  appendNodes(sidebar, localSec.details, filtersSec.details, groupsSec.details, displaySec.details, forcesSec.details, nodesSec.details, helpHint);
  const syncWorkspace = async (forceFull = false) => {
    try {
      isLoading = true;
      statsPill.textContent = copy.loadingLabel;
      await indexer.syncIndex({
        maxNotes: state.maxNotes,
        includeAttachments: state.filters.showAttachments,
        forceFull,
        signal: abortController.signal
      });
      if (abortController.signal.aborted)
        return;
      isLoading = false;
      if (state.mode === "local" && !state.focusNoteId) {
        const activeId = await indexer.resolveActiveNoteId();
        state.focusNoteId = activeId ?? indexer.getSnapshot().notes[0]?.id ?? null;
      }
      rebuildGraph({ fitIfFirst: true });
    } catch (error) {
      if (abortController.signal.aborted)
        return;
      isLoading = false;
      const msg = error instanceof Error ? error.message : String(error);
      context.ui.showNotice(copy.noticeRefreshFailed(msg));
      rebuildGraph();
    }
  };
  const unsubscribeIndexer = indexer.subscribe(() => {
    if (!isLoading)
      rebuildGraph();
  });
  const unsubscribeSettings = context.events.on("settings.changed", async ({ key }) => {
    if (key === "filters.show-tags") {
      state.filters.showTags = await readBooleanSetting(context, key, false);
    } else if (key === "filters.show-attachments") {
      state.filters.showAttachments = await readBooleanSetting(context, key, false);
      if (state.filters.showAttachments)
        await indexer.ensureAttachmentsLoaded(abortController.signal);
    } else if (key === "filters.existing-files-only") {
      state.filters.existingFilesOnly = await readBooleanSetting(context, key, false);
    } else if (key === "filters.show-orphans") {
      state.filters.showOrphans = await readBooleanSetting(context, key, true);
    } else if (key === "filters.excluded-patterns") {
      state.filters.excludedPatterns = await readStringSetting(context, key, "");
    } else if (key === "display.show-arrows") {
      state.display.showArrows = await readBooleanSetting(context, key, false);
      renderer.setDisplay(state.display);
    } else if (key === "general.local-depth") {
      state.localDepth = await readNumberSetting(context, key, 1, 1, 5);
    } else if (key === "general.max-notes") {
      state.maxNotes = await readNumberSetting(context, key, 1000, 50, 5000);
      syncWorkspace(false);
    }
    syncSidebarInputs();
    syncShell();
    rebuildGraph();
  });
  syncShell();
  if (indexer.getSnapshot().notes.length > 0) {
    isLoading = false;
    await indexer.applyActiveEditorOverlay();
    rebuildGraph({ fitIfFirst: true });
  }
  syncWorkspace(false);
  return () => {
    abortController.abort();
    if (savePrefsTimer)
      clearTimeout(savePrefsTimer);
    unsubscribeIndexer();
    unsubscribeSettings();
    renderer.destroy();
    root.remove();
  };
};

// src/index.ts
var PLUGIN_ID = "io.github.fdkgenie.graph-view";
var PANEL_ID = "graph-view";
var plugin = {
  activate(context) {
    const copy = getGraphCopy();
    const indexer = new GraphWorkspaceIndexer(context);
    const disposeEvents = indexer.subscribeWorkspaceEvents();
    let fallbackStyleEl = null;
    if (typeof document !== "undefined" && document.head && !document.querySelector(`style[data-edgeever-plugin-style="${PLUGIN_ID}"]`) && true && `.ee-gv-root {
  --ee-gv-bg: var(--edgeever-theme-background, hsl(var(--background, 210 20% 98%)));
  --ee-gv-surface: var(--edgeever-theme-surface, hsl(var(--card, 0 0% 100%)));
  --ee-gv-surface-muted: var(--edgeever-theme-surface-muted, hsl(var(--muted, 210 20% 96%)));
  --ee-gv-text: var(--edgeever-theme-text, hsl(var(--foreground, 222 47% 11%)));
  --ee-gv-text-muted: var(--edgeever-theme-text-muted, hsl(var(--muted-foreground, 215 16% 42%)));
  --ee-gv-border: var(--edgeever-theme-border, hsl(var(--border, 214 20% 86%)));
  --ee-gv-accent: var(--edgeever-theme-accent, #16a06e);
  --ee-gv-accent-fg: var(--edgeever-theme-accent-foreground, #ffffff);
  --ee-gv-node-default: #475569;
  --ee-gv-node-tag: #0d9488;
  --ee-gv-node-attachment: #6366f1;
  --ee-gv-node-unresolved: #94a3b8;
  --ee-gv-edge: rgba(100, 116, 139, 0.42);
  --ee-gv-shadow: 0 4px 18px rgba(15, 23, 42, 0.08);
  color-scheme: light;
  accent-color: var(--ee-gv-accent);
  position: relative;
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  min-height: 440px;
  overflow: hidden;
  border: 1px solid var(--ee-gv-border);
  border-radius: 12px;
  background: var(--ee-gv-bg);
  color: var(--ee-gv-text);
  font-family: var(--edgeever-theme-font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif);
  font-size: 13px;
}

:where(html.dark) .ee-gv-root {
  --ee-gv-bg: var(--edgeever-theme-background, hsl(var(--background, 222 47% 8%)));
  --ee-gv-surface: var(--edgeever-theme-surface, hsl(var(--card, 222 39% 12%)));
  --ee-gv-surface-muted: var(--edgeever-theme-surface-muted, hsl(var(--muted, 217 33% 17%)));
  --ee-gv-text: var(--edgeever-theme-text, hsl(var(--foreground, 210 40% 96%)));
  --ee-gv-text-muted: var(--edgeever-theme-text-muted, hsl(var(--muted-foreground, 215 20% 68%)));
  --ee-gv-border: var(--edgeever-theme-border, hsl(var(--border, 217 24% 26%)));
  --ee-gv-accent: var(--edgeever-theme-accent, #34d399);
  --ee-gv-accent-fg: var(--edgeever-theme-accent-foreground, #052e16);
  --ee-gv-node-default: #cbd5e1;
  --ee-gv-node-tag: #2dd4bf;
  --ee-gv-node-attachment: #818cf8;
  --ee-gv-node-unresolved: #64748b;
  --ee-gv-edge: rgba(148, 163, 184, 0.34);
  --ee-gv-shadow: 0 8px 28px rgba(0, 0, 0, 0.36);
  color-scheme: dark;
  accent-color: var(--ee-gv-accent);
}

@media (prefers-color-scheme: dark) {
  :where(html:not(.light)) .ee-gv-root {
    --ee-gv-bg: var(--edgeever-theme-background, hsl(var(--background, 222 47% 8%)));
    --ee-gv-surface: var(--edgeever-theme-surface, hsl(var(--card, 222 39% 12%)));
    --ee-gv-surface-muted: var(--edgeever-theme-surface-muted, hsl(var(--muted, 217 33% 17%)));
    --ee-gv-text: var(--edgeever-theme-text, hsl(var(--foreground, 210 40% 96%)));
    --ee-gv-text-muted: var(--edgeever-theme-text-muted, hsl(var(--muted-foreground, 215 20% 68%)));
    --ee-gv-border: var(--edgeever-theme-border, hsl(var(--border, 217 24% 26%)));
    --ee-gv-accent: var(--edgeever-theme-accent, #34d399);
    --ee-gv-accent-fg: var(--edgeever-theme-accent-foreground, #052e16);
    --ee-gv-node-default: #cbd5e1;
    --ee-gv-node-tag: #2dd4bf;
    --ee-gv-node-attachment: #818cf8;
    --ee-gv-node-unresolved: #64748b;
    --ee-gv-edge: rgba(148, 163, 184, 0.34);
    --ee-gv-shadow: 0 8px 28px rgba(0, 0, 0, 0.36);
    color-scheme: dark;
    accent-color: var(--ee-gv-accent);
  }
}

.ee-gv-root *,
.ee-gv-root *::before,
.ee-gv-root *::after {
  box-sizing: border-box;
}

.ee-gv-root :is(button, input, select, summary, canvas):focus-visible {
  outline: 2px solid var(--ee-gv-accent);
  outline-offset: 2px;
}

.ee-gv-stage {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ee-gv-bg);
}

.ee-gv-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: grab;
  user-select: none;
}

.ee-gv-canvas[data-dragging="true"] {
  cursor: grabbing;
}

.ee-gv-canvas[data-hovering="true"] {
  cursor: pointer;
}

.ee-gv-hud-top-left {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 4;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.ee-gv-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--ee-gv-border);
  background: color-mix(in srgb, var(--ee-gv-surface) 92%, transparent);
  color: var(--ee-gv-text);
  font-size: 12px;
  font-weight: 500;
  box-shadow: var(--ee-gv-shadow);
  pointer-events: auto;
}

.ee-gv-timelapse-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--ee-gv-border);
  background: color-mix(in srgb, var(--ee-gv-surface) 94%, transparent);
  font-size: 12px;
  box-shadow: var(--ee-gv-shadow);
  pointer-events: auto;
}

.ee-gv-timelapse-bar progress {
  width: 96px;
  height: 6px;
  border-radius: 999px;
}

.ee-gv-hud-bottom-left {
  position: absolute;
  bottom: 12px;
  left: 12px;
  z-index: 4;
  max-width: min(320px, calc(100% - 88px));
  pointer-events: none;
}

.ee-gv-preview-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--ee-gv-border);
  background: color-mix(in srgb, var(--ee-gv-surface) 96%, transparent);
  box-shadow: var(--ee-gv-shadow);
  pointer-events: auto;
}

.ee-gv-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ee-gv-preview-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ee-gv-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ee-gv-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--ee-gv-border);
  background: var(--ee-gv-surface-muted);
  color: var(--ee-gv-text-muted);
  font-size: 11px;
}

.ee-gv-preview-meta {
  font-size: 11px;
  color: var(--ee-gv-text-muted);
}

.ee-gv-preview-excerpt {
  font-size: 12px;
  line-height: 1.4;
  color: var(--ee-gv-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ee-gv-preview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.ee-gv-hud-bottom-right {
  position: absolute;
  bottom: 12px;
  right: 12px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ee-gv-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  padding: 0;
  border: 1px solid var(--ee-gv-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ee-gv-surface) 94%, transparent);
  color: var(--ee-gv-text);
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--ee-gv-shadow);
}

.ee-gv-icon-btn:hover {
  background: var(--ee-gv-surface-muted);
}

.ee-gv-empty-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background: color-mix(in srgb, var(--ee-gv-bg) 82%, transparent);
}

.ee-gv-empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--ee-gv-text);
}

.ee-gv-empty-desc {
  margin: 0;
  max-width: 340px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ee-gv-text-muted);
}

.ee-gv-sidebar {
  flex: 0 0 296px;
  width: 296px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  border-left: 1px solid var(--ee-gv-border);
  background: var(--ee-gv-surface);
  scrollbar-width: thin;
}

.ee-gv-sidebar[hidden] {
  display: none;
}

.ee-gv-section {
  border-bottom: 1px solid var(--ee-gv-border);
}

.ee-gv-summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ee-gv-text);
  cursor: pointer;
  user-select: none;
}

.ee-gv-summary::-webkit-details-marker {
  display: none;
}

.ee-gv-summary::before {
  content: "";
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-right: 1.75px solid currentColor;
  border-bottom: 1.75px solid currentColor;
  transform: translateY(-1px) rotate(-45deg);
}

.ee-gv-section[open] > .ee-gv-summary::before {
  transform: translateY(-2px) rotate(45deg);
}

@media (prefers-reduced-motion: no-preference) {
  .ee-gv-summary::before {
    transition: transform 0.16s ease;
  }
}

.ee-gv-summary:hover {
  background: var(--ee-gv-surface-muted);
}

.ee-gv-section-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 12px 14px;
}

.ee-gv-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ee-gv-field-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--ee-gv-text);
}

.ee-gv-field-value {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--ee-gv-text-muted);
}

.ee-gv-input,
.ee-gv-select {
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--ee-gv-border);
  border-radius: 6px;
  background: var(--ee-gv-bg);
  color: var(--ee-gv-text);
  font-size: 12px;
}

.ee-gv-checkbox {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 28px;
  font-size: 12px;
  color: var(--ee-gv-text);
  cursor: pointer;
}

.ee-gv-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  flex-shrink: 0;
  cursor: pointer;
}

.ee-gv-range {
  width: 100%;
  min-height: 24px;
  margin: 0;
  cursor: pointer;
}

.ee-gv-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--ee-gv-border);
  border-radius: 6px;
  background: var(--ee-gv-surface);
  color: var(--ee-gv-text);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.ee-gv-btn:hover {
  background: var(--ee-gv-surface-muted);
}

.ee-gv-btn-primary {
  border-color: var(--ee-gv-accent);
  background: var(--ee-gv-accent);
  color: var(--ee-gv-accent-fg);
}

.ee-gv-btn-primary:hover {
  filter: brightness(0.95);
  background: var(--ee-gv-accent);
}

.ee-gv-group-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
}

.ee-gv-color-input {
  width: 28px;
  height: 28px;
  padding: 2px;
  border: 1px solid var(--ee-gv-border);
  border-radius: 6px;
  background: var(--ee-gv-bg);
  cursor: pointer;
}

.ee-gv-group-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ee-gv-mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  min-height: 24px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--ee-gv-text-muted);
  font-size: 12px;
  cursor: pointer;
}

.ee-gv-mini-btn:hover {
  border-color: var(--ee-gv-border);
  background: var(--ee-gv-surface-muted);
  color: var(--ee-gv-text);
}

.ee-gv-node-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}

.ee-gv-node-item-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ee-gv-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.ee-gv-node-item-btn:hover {
  background: var(--ee-gv-surface-muted);
}

.ee-gv-node-item-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}

.ee-gv-node-item-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ee-gv-node-item-deg {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ee-gv-text-muted);
  font-variant-numeric: tabular-nums;
}

.ee-gv-help-hint {
  margin: 0;
  padding: 8px 12px 12px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ee-gv-text-muted);
}

.ee-gv-tooltip {
  position: fixed;
  z-index: 9999;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--ee-gv-border);
  background: var(--ee-gv-text);
  color: var(--ee-gv-bg);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: var(--ee-gv-shadow);
}

.ee-gv-sr-only {
  position: absolute !important;
  clip-path: inset(50%) !important;
  overflow: hidden !important;
  width: 1px !important;
  height: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  border: 0 !important;
  white-space: nowrap !important;
}

/* Fallback for browsers without CSS accent-color support */
@supports not (accent-color: #16a06e) {
  .ee-gv-checkbox input[type="checkbox"] {
    position: absolute !important;
    clip-path: inset(50%) !important;
    overflow: hidden !important;
    width: 1px !important;
    height: 1px !important;
    margin: -1px !important;
    padding: 0 !important;
    border: 0 !important;
    white-space: nowrap !important;
  }

  .ee-gv-checkbox span {
    position: relative;
    padding-right: 26px;
    flex: 1 1 auto;
  }

  .ee-gv-checkbox span::before {
    content: "";
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    border: 2px solid var(--ee-gv-border);
    border-radius: 4px;
    background: var(--ee-gv-bg);
  }

  .ee-gv-checkbox input[type="checkbox"]:focus-visible + span::before {
    outline: 2px solid var(--ee-gv-accent);
    outline-offset: 2px;
  }

  .ee-gv-checkbox input[type="checkbox"]:checked + span::before {
    background: var(--ee-gv-accent);
    border-color: var(--ee-gv-accent);
  }

  .ee-gv-checkbox input[type="checkbox"]:checked + span::after {
    content: "✓";
    position: absolute;
    right: 3px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--ee-gv-accent-fg);
    font-size: 11px;
    font-weight: 700;
  }

  .ee-gv-range {
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
  }

  .ee-gv-range::-webkit-slider-runnable-track {
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: var(--ee-gv-border);
  }

  .ee-gv-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--ee-gv-accent);
  }

  .ee-gv-range::-moz-range-track {
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: var(--ee-gv-border);
  }

  .ee-gv-range::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border: none;
    border-radius: 50%;
    background: var(--ee-gv-accent);
  }

  .ee-gv-range::-moz-range-progress {
    height: 6px;
    border-radius: 999px;
    background: var(--ee-gv-accent);
  }
}

@media (max-width: 820px) {
  .ee-gv-root {
    flex-direction: column;
  }

  .ee-gv-sidebar {
    flex: 0 0 auto;
    width: 100%;
    max-height: 44%;
    border-left: none;
    border-top: 1px solid var(--ee-gv-border);
  }
}

@media (pointer: coarse) {
  .ee-gv-icon-btn,
  .ee-gv-btn,
  .ee-gv-mini-btn,
  .ee-gv-checkbox {
    min-height: 36px;
  }

  .ee-gv-icon-btn {
    min-width: 36px;
  }
}

@media (forced-colors: active) {
  .ee-gv-root,
  .ee-gv-pill,
  .ee-gv-preview-card,
  .ee-gv-icon-btn,
  .ee-gv-btn,
  .ee-gv-input,
  .ee-gv-select,
  .ee-gv-sidebar {
    border: 1px solid ButtonBorder;
    background: Canvas;
    color: CanvasText;
  }

  .ee-gv-root :is(button, input, select, summary, canvas):focus-visible {
    outline: 2px solid Highlight;
  }
}
`) {
      fallbackStyleEl = document.createElement("style");
      fallbackStyleEl.dataset.edgeeverPluginStyle = PLUGIN_ID;
      fallbackStyleEl.textContent = `.ee-gv-root {
  --ee-gv-bg: var(--edgeever-theme-background, hsl(var(--background, 210 20% 98%)));
  --ee-gv-surface: var(--edgeever-theme-surface, hsl(var(--card, 0 0% 100%)));
  --ee-gv-surface-muted: var(--edgeever-theme-surface-muted, hsl(var(--muted, 210 20% 96%)));
  --ee-gv-text: var(--edgeever-theme-text, hsl(var(--foreground, 222 47% 11%)));
  --ee-gv-text-muted: var(--edgeever-theme-text-muted, hsl(var(--muted-foreground, 215 16% 42%)));
  --ee-gv-border: var(--edgeever-theme-border, hsl(var(--border, 214 20% 86%)));
  --ee-gv-accent: var(--edgeever-theme-accent, #16a06e);
  --ee-gv-accent-fg: var(--edgeever-theme-accent-foreground, #ffffff);
  --ee-gv-node-default: #475569;
  --ee-gv-node-tag: #0d9488;
  --ee-gv-node-attachment: #6366f1;
  --ee-gv-node-unresolved: #94a3b8;
  --ee-gv-edge: rgba(100, 116, 139, 0.42);
  --ee-gv-shadow: 0 4px 18px rgba(15, 23, 42, 0.08);
  color-scheme: light;
  accent-color: var(--ee-gv-accent);
  position: relative;
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  min-height: 440px;
  overflow: hidden;
  border: 1px solid var(--ee-gv-border);
  border-radius: 12px;
  background: var(--ee-gv-bg);
  color: var(--ee-gv-text);
  font-family: var(--edgeever-theme-font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif);
  font-size: 13px;
}

:where(html.dark) .ee-gv-root {
  --ee-gv-bg: var(--edgeever-theme-background, hsl(var(--background, 222 47% 8%)));
  --ee-gv-surface: var(--edgeever-theme-surface, hsl(var(--card, 222 39% 12%)));
  --ee-gv-surface-muted: var(--edgeever-theme-surface-muted, hsl(var(--muted, 217 33% 17%)));
  --ee-gv-text: var(--edgeever-theme-text, hsl(var(--foreground, 210 40% 96%)));
  --ee-gv-text-muted: var(--edgeever-theme-text-muted, hsl(var(--muted-foreground, 215 20% 68%)));
  --ee-gv-border: var(--edgeever-theme-border, hsl(var(--border, 217 24% 26%)));
  --ee-gv-accent: var(--edgeever-theme-accent, #34d399);
  --ee-gv-accent-fg: var(--edgeever-theme-accent-foreground, #052e16);
  --ee-gv-node-default: #cbd5e1;
  --ee-gv-node-tag: #2dd4bf;
  --ee-gv-node-attachment: #818cf8;
  --ee-gv-node-unresolved: #64748b;
  --ee-gv-edge: rgba(148, 163, 184, 0.34);
  --ee-gv-shadow: 0 8px 28px rgba(0, 0, 0, 0.36);
  color-scheme: dark;
  accent-color: var(--ee-gv-accent);
}

@media (prefers-color-scheme: dark) {
  :where(html:not(.light)) .ee-gv-root {
    --ee-gv-bg: var(--edgeever-theme-background, hsl(var(--background, 222 47% 8%)));
    --ee-gv-surface: var(--edgeever-theme-surface, hsl(var(--card, 222 39% 12%)));
    --ee-gv-surface-muted: var(--edgeever-theme-surface-muted, hsl(var(--muted, 217 33% 17%)));
    --ee-gv-text: var(--edgeever-theme-text, hsl(var(--foreground, 210 40% 96%)));
    --ee-gv-text-muted: var(--edgeever-theme-text-muted, hsl(var(--muted-foreground, 215 20% 68%)));
    --ee-gv-border: var(--edgeever-theme-border, hsl(var(--border, 217 24% 26%)));
    --ee-gv-accent: var(--edgeever-theme-accent, #34d399);
    --ee-gv-accent-fg: var(--edgeever-theme-accent-foreground, #052e16);
    --ee-gv-node-default: #cbd5e1;
    --ee-gv-node-tag: #2dd4bf;
    --ee-gv-node-attachment: #818cf8;
    --ee-gv-node-unresolved: #64748b;
    --ee-gv-edge: rgba(148, 163, 184, 0.34);
    --ee-gv-shadow: 0 8px 28px rgba(0, 0, 0, 0.36);
    color-scheme: dark;
    accent-color: var(--ee-gv-accent);
  }
}

.ee-gv-root *,
.ee-gv-root *::before,
.ee-gv-root *::after {
  box-sizing: border-box;
}

.ee-gv-root :is(button, input, select, summary, canvas):focus-visible {
  outline: 2px solid var(--ee-gv-accent);
  outline-offset: 2px;
}

.ee-gv-stage {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ee-gv-bg);
}

.ee-gv-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: grab;
  user-select: none;
}

.ee-gv-canvas[data-dragging="true"] {
  cursor: grabbing;
}

.ee-gv-canvas[data-hovering="true"] {
  cursor: pointer;
}

.ee-gv-hud-top-left {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 4;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.ee-gv-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--ee-gv-border);
  background: color-mix(in srgb, var(--ee-gv-surface) 92%, transparent);
  color: var(--ee-gv-text);
  font-size: 12px;
  font-weight: 500;
  box-shadow: var(--ee-gv-shadow);
  pointer-events: auto;
}

.ee-gv-timelapse-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--ee-gv-border);
  background: color-mix(in srgb, var(--ee-gv-surface) 94%, transparent);
  font-size: 12px;
  box-shadow: var(--ee-gv-shadow);
  pointer-events: auto;
}

.ee-gv-timelapse-bar progress {
  width: 96px;
  height: 6px;
  border-radius: 999px;
}

.ee-gv-hud-bottom-left {
  position: absolute;
  bottom: 12px;
  left: 12px;
  z-index: 4;
  max-width: min(320px, calc(100% - 88px));
  pointer-events: none;
}

.ee-gv-preview-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--ee-gv-border);
  background: color-mix(in srgb, var(--ee-gv-surface) 96%, transparent);
  box-shadow: var(--ee-gv-shadow);
  pointer-events: auto;
}

.ee-gv-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ee-gv-preview-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ee-gv-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ee-gv-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--ee-gv-border);
  background: var(--ee-gv-surface-muted);
  color: var(--ee-gv-text-muted);
  font-size: 11px;
}

.ee-gv-preview-meta {
  font-size: 11px;
  color: var(--ee-gv-text-muted);
}

.ee-gv-preview-excerpt {
  font-size: 12px;
  line-height: 1.4;
  color: var(--ee-gv-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ee-gv-preview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.ee-gv-hud-bottom-right {
  position: absolute;
  bottom: 12px;
  right: 12px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ee-gv-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  padding: 0;
  border: 1px solid var(--ee-gv-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ee-gv-surface) 94%, transparent);
  color: var(--ee-gv-text);
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--ee-gv-shadow);
}

.ee-gv-icon-btn:hover {
  background: var(--ee-gv-surface-muted);
}

.ee-gv-empty-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background: color-mix(in srgb, var(--ee-gv-bg) 82%, transparent);
}

.ee-gv-empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--ee-gv-text);
}

.ee-gv-empty-desc {
  margin: 0;
  max-width: 340px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ee-gv-text-muted);
}

.ee-gv-sidebar {
  flex: 0 0 296px;
  width: 296px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  border-left: 1px solid var(--ee-gv-border);
  background: var(--ee-gv-surface);
  scrollbar-width: thin;
}

.ee-gv-sidebar[hidden] {
  display: none;
}

.ee-gv-section {
  border-bottom: 1px solid var(--ee-gv-border);
}

.ee-gv-summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ee-gv-text);
  cursor: pointer;
  user-select: none;
}

.ee-gv-summary::-webkit-details-marker {
  display: none;
}

.ee-gv-summary::before {
  content: "";
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-right: 1.75px solid currentColor;
  border-bottom: 1.75px solid currentColor;
  transform: translateY(-1px) rotate(-45deg);
}

.ee-gv-section[open] > .ee-gv-summary::before {
  transform: translateY(-2px) rotate(45deg);
}

@media (prefers-reduced-motion: no-preference) {
  .ee-gv-summary::before {
    transition: transform 0.16s ease;
  }
}

.ee-gv-summary:hover {
  background: var(--ee-gv-surface-muted);
}

.ee-gv-section-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 12px 14px;
}

.ee-gv-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ee-gv-field-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--ee-gv-text);
}

.ee-gv-field-value {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--ee-gv-text-muted);
}

.ee-gv-input,
.ee-gv-select {
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--ee-gv-border);
  border-radius: 6px;
  background: var(--ee-gv-bg);
  color: var(--ee-gv-text);
  font-size: 12px;
}

.ee-gv-checkbox {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 28px;
  font-size: 12px;
  color: var(--ee-gv-text);
  cursor: pointer;
}

.ee-gv-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  flex-shrink: 0;
  cursor: pointer;
}

.ee-gv-range {
  width: 100%;
  min-height: 24px;
  margin: 0;
  cursor: pointer;
}

.ee-gv-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--ee-gv-border);
  border-radius: 6px;
  background: var(--ee-gv-surface);
  color: var(--ee-gv-text);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.ee-gv-btn:hover {
  background: var(--ee-gv-surface-muted);
}

.ee-gv-btn-primary {
  border-color: var(--ee-gv-accent);
  background: var(--ee-gv-accent);
  color: var(--ee-gv-accent-fg);
}

.ee-gv-btn-primary:hover {
  filter: brightness(0.95);
  background: var(--ee-gv-accent);
}

.ee-gv-group-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
}

.ee-gv-color-input {
  width: 28px;
  height: 28px;
  padding: 2px;
  border: 1px solid var(--ee-gv-border);
  border-radius: 6px;
  background: var(--ee-gv-bg);
  cursor: pointer;
}

.ee-gv-group-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ee-gv-mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  min-height: 24px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--ee-gv-text-muted);
  font-size: 12px;
  cursor: pointer;
}

.ee-gv-mini-btn:hover {
  border-color: var(--ee-gv-border);
  background: var(--ee-gv-surface-muted);
  color: var(--ee-gv-text);
}

.ee-gv-node-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}

.ee-gv-node-item-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ee-gv-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.ee-gv-node-item-btn:hover {
  background: var(--ee-gv-surface-muted);
}

.ee-gv-node-item-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}

.ee-gv-node-item-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ee-gv-node-item-deg {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ee-gv-text-muted);
  font-variant-numeric: tabular-nums;
}

.ee-gv-help-hint {
  margin: 0;
  padding: 8px 12px 12px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ee-gv-text-muted);
}

.ee-gv-tooltip {
  position: fixed;
  z-index: 9999;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--ee-gv-border);
  background: var(--ee-gv-text);
  color: var(--ee-gv-bg);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: var(--ee-gv-shadow);
}

.ee-gv-sr-only {
  position: absolute !important;
  clip-path: inset(50%) !important;
  overflow: hidden !important;
  width: 1px !important;
  height: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  border: 0 !important;
  white-space: nowrap !important;
}

/* Fallback for browsers without CSS accent-color support */
@supports not (accent-color: #16a06e) {
  .ee-gv-checkbox input[type="checkbox"] {
    position: absolute !important;
    clip-path: inset(50%) !important;
    overflow: hidden !important;
    width: 1px !important;
    height: 1px !important;
    margin: -1px !important;
    padding: 0 !important;
    border: 0 !important;
    white-space: nowrap !important;
  }

  .ee-gv-checkbox span {
    position: relative;
    padding-right: 26px;
    flex: 1 1 auto;
  }

  .ee-gv-checkbox span::before {
    content: "";
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    border: 2px solid var(--ee-gv-border);
    border-radius: 4px;
    background: var(--ee-gv-bg);
  }

  .ee-gv-checkbox input[type="checkbox"]:focus-visible + span::before {
    outline: 2px solid var(--ee-gv-accent);
    outline-offset: 2px;
  }

  .ee-gv-checkbox input[type="checkbox"]:checked + span::before {
    background: var(--ee-gv-accent);
    border-color: var(--ee-gv-accent);
  }

  .ee-gv-checkbox input[type="checkbox"]:checked + span::after {
    content: "✓";
    position: absolute;
    right: 3px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--ee-gv-accent-fg);
    font-size: 11px;
    font-weight: 700;
  }

  .ee-gv-range {
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
  }

  .ee-gv-range::-webkit-slider-runnable-track {
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: var(--ee-gv-border);
  }

  .ee-gv-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--ee-gv-accent);
  }

  .ee-gv-range::-moz-range-track {
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: var(--ee-gv-border);
  }

  .ee-gv-range::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border: none;
    border-radius: 50%;
    background: var(--ee-gv-accent);
  }

  .ee-gv-range::-moz-range-progress {
    height: 6px;
    border-radius: 999px;
    background: var(--ee-gv-accent);
  }
}

@media (max-width: 820px) {
  .ee-gv-root {
    flex-direction: column;
  }

  .ee-gv-sidebar {
    flex: 0 0 auto;
    width: 100%;
    max-height: 44%;
    border-left: none;
    border-top: 1px solid var(--ee-gv-border);
  }
}

@media (pointer: coarse) {
  .ee-gv-icon-btn,
  .ee-gv-btn,
  .ee-gv-mini-btn,
  .ee-gv-checkbox {
    min-height: 36px;
  }

  .ee-gv-icon-btn {
    min-width: 36px;
  }
}

@media (forced-colors: active) {
  .ee-gv-root,
  .ee-gv-pill,
  .ee-gv-preview-card,
  .ee-gv-icon-btn,
  .ee-gv-btn,
  .ee-gv-input,
  .ee-gv-select,
  .ee-gv-sidebar {
    border: 1px solid ButtonBorder;
    background: Canvas;
    color: CanvasText;
  }

  .ee-gv-root :is(button, input, select, summary, canvas):focus-visible {
    outline: 2px solid Highlight;
  }
}
`;
      document.head.appendChild(fallbackStyleEl);
    }
    const disposePanel = context.ui.panels.register({
      id: PANEL_ID,
      title: copy.panelTitle,
      purpose: "dashboard",
      presentation: "fullscreen",
      mount(container, mountContext) {
        return mountGraphViewPanel({
          context,
          indexer,
          mountContext,
          container
        });
      }
    });
    const disposeOpenGlobal = context.commands.register({
      id: "open-graph-view",
      title: copy.commandOpenGlobal,
      listed: true,
      menu: false,
      async run() {
        await context.ui.panels.open(PANEL_ID, {
          state: { mode: "global" }
        });
      }
    });
    const disposeOpenLocal = context.commands.register({
      id: "open-local-graph",
      title: copy.commandOpenLocal,
      listed: true,
      menu: true,
      async run() {
        const focusNoteId = await indexer.resolveActiveNoteId();
        if (!focusNoteId) {
          context.ui.showNotice(copy.noticeNoActiveNote);
        }
        await context.ui.panels.open(PANEL_ID, {
          state: { mode: "local", ...focusNoteId ? { focusNoteId } : {} }
        });
      }
    });
    return () => {
      disposeOpenLocal();
      disposeOpenGlobal();
      disposePanel();
      disposeEvents();
      fallbackStyleEl?.remove();
    };
  }
};
var src_default = plugin;
export {
  src_default as default
};
