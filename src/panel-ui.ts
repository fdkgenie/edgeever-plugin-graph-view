import type { PluginContext, PluginPanelMountContext } from "./plugin-api-types";
import { GraphCanvasRenderer } from "./canvas-renderer";
import { ForceSimulation } from "./force-simulation";
import { buildGraphData } from "./graph-builder";
import { GraphWorkspaceIndexer } from "./graph-indexer";
import { getGraphCopy } from "./i18n";
import {
  DEFAULT_GRAPH_DISPLAY,
  DEFAULT_GRAPH_FILTERS,
  DEFAULT_GRAPH_FORCES,
  DEFAULT_GROUP_COLORS,
  type GraphColorGroup,
  type GraphData,
  type GraphNode,
  type GraphViewState,
  type LocalLinkDirection,
} from "./types";

const UI_PREFS_STORAGE_KEY = "graph-view-ui-prefs-v1";

interface StoredUiPrefs {
  localDirection?: LocalLinkDirection;
  sidebarOpen?: boolean;
  groups?: GraphColorGroup[];
  display?: Partial<GraphViewState["display"]>;
  forces?: Partial<GraphViewState["forces"]>;
}

const nextId = () => `grp_${Math.random().toString(36).slice(2, 9)}`;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const appendNodes = (parent: Node, ...children: Node[]) => {
  for (const child of children) parent.appendChild(child);
};

const readBooleanSetting = async (context: PluginContext, key: string, fallback: boolean): Promise<boolean> => {
  try {
    const val = await context.settings.get(key);
    return typeof val === "boolean" ? val : fallback;
  } catch {
    return fallback;
  }
};

const readNumberSetting = async (
  context: PluginContext,
  key: string,
  fallback: number,
  min: number,
  max: number,
): Promise<number> => {
  try {
    const val = await context.settings.get(key);
    return typeof val === "number" && Number.isFinite(val) ? clamp(val, min, max) : fallback;
  } catch {
    return fallback;
  }
};

const readStringSetting = async (context: PluginContext, key: string, fallback: string): Promise<string> => {
  try {
    const val = await context.settings.get(key);
    return typeof val === "string" ? val : fallback;
  } catch {
    return fallback;
  }
};

export interface PanelSessionOptions {
  context: PluginContext;
  indexer: GraphWorkspaceIndexer;
  mountContext: PluginPanelMountContext;
  container: HTMLElement;
}

export const mountGraphViewPanel = async ({
  context,
  indexer,
  mountContext,
  container,
}: PanelSessionOptions): Promise<() => void> => {
  const copy = getGraphCopy();
  const abortController = new AbortController();
  const instanceId = `gv_${Math.random().toString(36).slice(2, 7)}`;

  const panelState = (mountContext.state && typeof mountContext.state === "object" && !Array.isArray(mountContext.state)
    ? mountContext.state
    : {}) as { mode?: string; focusNoteId?: string | null };

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
    activeEditorNoteId,
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
    context.storage.get<StoredUiPrefs>(UI_PREFS_STORAGE_KEY).catch(() => null),
    indexer.resolveActiveNoteId(),
  ]);

  if (abortController.signal.aborted) return () => undefined;

  const initialMode = panelState.mode === "local" || (panelState.mode !== "global" && defaultMode === "local")
    ? "local"
    : "global";
  const initialFocusNoteId = typeof panelState.focusNoteId === "string" && panelState.focusNoteId
    ? panelState.focusNoteId
    : activeEditorNoteId;

  const state: GraphViewState = {
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
      excludedPatterns,
    },
    groups: Array.isArray(prefs?.groups)
      ? prefs.groups.map((grp) => ({
          id: typeof grp.id === "string" ? grp.id : nextId(),
          query: typeof grp.query === "string" ? grp.query : "",
          color: typeof grp.color === "string" ? grp.color : DEFAULT_GROUP_COLORS[0],
          enabled: grp.enabled !== false,
        }))
      : [],
    display: {
      showArrows,
      textFadeThreshold: typeof prefs?.display?.textFadeThreshold === "number"
        ? clamp(prefs.display.textFadeThreshold, -2, 2)
        : DEFAULT_GRAPH_DISPLAY.textFadeThreshold,
      nodeSize: typeof prefs?.display?.nodeSize === "number"
        ? clamp(prefs.display.nodeSize, 0.5, 2.5)
        : DEFAULT_GRAPH_DISPLAY.nodeSize,
      linkThickness: typeof prefs?.display?.linkThickness === "number"
        ? clamp(prefs.display.linkThickness, 0.4, 3)
        : DEFAULT_GRAPH_DISPLAY.linkThickness,
    },
    forces: {
      centerForce: typeof prefs?.forces?.centerForce === "number"
        ? clamp(prefs.forces.centerForce, 0, 1)
        : DEFAULT_GRAPH_FORCES.centerForce,
      repelForce: typeof prefs?.forces?.repelForce === "number"
        ? clamp(prefs.forces.repelForce, 1, 22)
        : DEFAULT_GRAPH_FORCES.repelForce,
      linkForce: typeof prefs?.forces?.linkForce === "number"
        ? clamp(prefs.forces.linkForce, 0.1, 2)
        : DEFAULT_GRAPH_FORCES.linkForce,
      linkDistance: typeof prefs?.forces?.linkDistance === "number"
        ? clamp(prefs.forces.linkDistance, 40, 280)
        : DEFAULT_GRAPH_FORCES.linkDistance,
    },
  };

  let sidebarOpen = prefs?.sidebarOpen !== false;
  let isLoading = true;
  let currentGraph: GraphData | null = null;
  let hoveredNode: GraphNode | null = null;
  let timelapseRunning = false;
  let savePrefsTimer: ReturnType<typeof setTimeout> | null = null;

  const schedulePersistUiPrefs = () => {
    if (savePrefsTimer) clearTimeout(savePrefsTimer);
    savePrefsTimer = setTimeout(() => {
      void context.storage.set<StoredUiPrefs>(UI_PREFS_STORAGE_KEY, {
        localDirection: state.localDirection,
        sidebarOpen,
        groups: state.groups,
        display: state.display,
        forces: state.forces,
      }).catch(() => undefined);
    }, 180);
  };

  // Root DOM layout
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

  // Single accessible tooltip instance (never HTML native title)
  const tooltip = document.createElement("div");
  tooltip.className = "ee-gv-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.id = `${instanceId}-tooltip`;
  tooltip.hidden = true;

  const showTooltip = (target: HTMLElement, text: string) => {
    tooltip.textContent = text;
    tooltip.hidden = false;
    target.setAttribute("aria-describedby", tooltip.id);
    const rect = target.getBoundingClientRect?.();
    if (!rect) return;
    tooltip.style.left = `${Math.max(8, rect.left - tooltip.offsetWidth - 8)}px`;
    tooltip.style.top = `${Math.max(8, rect.top + (rect.height - tooltip.offsetHeight) * 0.5)}px`;
  };

  const hideTooltip = (target?: HTMLElement) => {
    tooltip.hidden = true;
    target?.removeAttribute("aria-describedby");
  };

  const attachTooltip = (button: HTMLButtonElement, label: string) => {
    button.setAttribute("aria-label", label);
    button.addEventListener("pointerenter", () => showTooltip(button, label));
    button.addEventListener("pointerleave", () => hideTooltip(button));
    button.addEventListener("focusin", () => showTooltip(button, label));
    button.addEventListener("focusout", () => hideTooltip(button));
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideTooltip(button);
    });
  };

  const makeHudButton = (glyph: string, label: string, onClick: () => void) => {
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

  const openNoteFromGraph = async (noteId: string) => {
    try {
      await context.ui.openNote(noteId);
      await mountContext.requestClose();
    } catch (error) {
      context.ui.showNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const focusLocalNote = (noteId: string) => {
    state.mode = "local";
    state.focusNoteId = noteId;
    syncShell();
    rebuildGraph({ fitIfFirst: true });
    renderer.fitToView();
  };

  const handleActivateNode = (node: GraphNode) => {
    if (node.nodeType === "note") {
      void openNoteFromGraph(node.rawId);
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
          void openNoteFromGraph(edge.source.slice(5));
          return;
        }
      }
    }
  };

  const renderPreviewCard = (node: GraphNode | null) => {
    hoveredNode = node;
    hudBottomLeft.replaceChildren();
    if (!node) return;

    const card = document.createElement("div");
    card.className = "ee-gv-preview-card";

    const header = document.createElement("div");
    header.className = "ee-gv-preview-header";

    const title = document.createElement("span");
    title.className = "ee-gv-preview-title";
    title.textContent = node.label;

    const badgeText = node.nodeType === "unresolved"
      ? copy.unresolvedBadge
      : node.nodeType === "tag"
        ? copy.tagBadge
        : node.nodeType === "attachment"
          ? copy.attachmentBadge
          : node.notebookPath || node.noteKind || "text";
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
      if (node.nodeType === "note") focusLocalNote(node.rawId);
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
    },
  });

  appendNodes(
    hudBottomRight,
    makeHudButton("+", copy.actionZoomIn, () => renderer.zoomBy(1.25)),
    makeHudButton("−", copy.actionZoomOut, () => renderer.zoomBy(1 / 1.25)),
    makeHudButton("⌖", copy.actionFit, () => renderer.fitToView()),
    makeHudButton("↻", copy.actionReheat, () => {
      simulation.reheat(0.95);
      renderer.scheduleFrame();
    }),
  );

  // Sidebar controls references for reactive updates
  let localSectionEl: HTMLDetailsElement;
  let localSelectEl: HTMLSelectElement;
  let groupsListEl: HTMLDivElement;
  let nodeListEl: HTMLUListElement;
  let nodesSummaryLabelEl: HTMLSpanElement;
  let excludedInputRef: HTMLInputElement | null = null;
  let animateSidebarBtn: HTMLButtonElement | null = null;

  const syncLocalSelectOptions = () => {
    const snapshot = indexer.getSnapshot();
    const sorted = [...snapshot.notes].sort((a, b) =>
      (a.title || a.excerpt || copy.untitledNote).localeCompare(b.title || b.excerpt || copy.untitledNote),
    );
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
      if (isSelected) matchedOption = true;
      appendNodes(localSelectEl, opt);
    }
    if (!matchedOption) placeholder.selected = true;
    localSectionEl.hidden = state.mode !== "local";
  };

  const renderVisibleNodesList = (graph: GraphData) => {
    nodesSummaryLabelEl.textContent = `${copy.sectionNodes} (${graph.nodes.length})`;
    nodeListEl.replaceChildren();
    const topNodes = [...graph.nodes]
      .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
      .slice(0, 80);

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
      dot.style.backgroundColor = node.groupColor
        ?? (node.nodeType === "tag"
          ? "#0d9488"
          : node.nodeType === "attachment"
            ? "#6366f1"
            : node.nodeType === "unresolved"
              ? "#94a3b8"
              : "#16a06e");

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

  const updateEmptyOverlay = (graph: GraphData) => {
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
      if (excludedInputRef) excludedInputRef.value = "";
      syncSidebarInputs();
      syncShell();
      rebuildGraph({ fitIfFirst: true });
    });
    appendNodes(emptyOverlay, titleEl, descEl, resetBtn);
  };

  const rebuildGraph = (options?: { fitIfFirst?: boolean; preservePositions?: boolean }) => {
    const snapshot = indexer.getSnapshot();
    const graph = buildGraphData({
      notes: snapshot.notes,
      notebooks: snapshot.notebooks,
      attachments: snapshot.attachments,
      state,
      untitledLabel: copy.untitledNote,
    });
    currentGraph = graph;
    simulation.setForces(state.forces);
    simulation.setGraph(graph.nodes, graph.edges, {
      preservePositions: options?.preservePositions,
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
    const toolbar: Parameters<PluginPanelMountContext["shell"]["set"]>[0]["toolbar"] = [
      {
        type: "tabs",
        key: "mode",
        value: state.mode,
        options: [
          { value: "global", label: copy.tabGlobal },
          { value: "local", label: copy.tabLocal },
        ],
      },
      {
        type: "search",
        key: "search",
        placeholder: copy.searchPlaceholder,
        value: state.filters.search,
      },
    ];

    if (state.mode === "local") {
      toolbar.push(
        {
          type: "select",
          key: "localDepth",
          label: copy.depthLabel,
          value: String(state.localDepth),
          options: [1, 2, 3, 4, 5].map((depth) => ({ value: String(depth), label: String(depth) })),
        },
        {
          type: "select",
          key: "localDirection",
          label: copy.directionLabel,
          value: state.localDirection,
          options: [
            { value: "both", label: copy.directionBoth },
            { value: "outgoing", label: copy.directionOutgoing },
            { value: "incoming", label: copy.directionIncoming },
          ],
        },
      );
    }

    mountContext.shell.set({
      header: {
        title: copy.panelTitle,
        description: null,
        actions: [
          {
            id: "animate",
            label: timelapseRunning ? copy.actionStopAnimate : copy.actionAnimate,
            variant: timelapseRunning ? "primary" : "default",
          },
          { id: "fit", label: copy.actionFit },
          { id: "refresh", label: copy.actionRefresh },
          {
            id: "controls",
            label: copy.actionControls,
            variant: sidebarOpen ? "primary" : "default",
          },
        ],
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
          void syncWorkspace(true);
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
            if (firstNote) state.focusNoteId = firstNote.id;
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
      },
    });
  };

  // Helper builders for sidebar controls
  const createSection = (titleText: string, openByDefault: boolean) => {
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

  const makeCheckbox = (
    idSuffix: string,
    labelText: string,
    initial: boolean,
    onToggle: (checked: boolean) => void,
  ) => {
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

  const makeSlider = (
    idSuffix: string,
    labelText: string,
    min: number,
    max: number,
    step: number,
    initial: number,
    formatValue: (val: number) => string,
    onInput: (val: number) => void,
  ) => {
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

  // Section 1: Local Target
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

  // Section 2: Filters
  const filtersSec = createSection(copy.sectionFilters, true);
  const cbTags = makeCheckbox("filter-tags", copy.filterTags, state.filters.showTags, (checked) => {
    state.filters.showTags = checked;
    rebuildGraph();
  });
  const cbAttachments = makeCheckbox("filter-attachments", copy.filterAttachments, state.filters.showAttachments, async (checked) => {
    state.filters.showAttachments = checked;
    if (checked) await indexer.ensureAttachmentsLoaded(abortController.signal);
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

  // Section 3: Color Groups
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
        if (index === 0) return;
        const prev = state.groups[index - 1]!;
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
        if (index >= state.groups.length - 1) return;
        const next = state.groups[index + 1]!;
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
    const color = DEFAULT_GROUP_COLORS[state.groups.length % DEFAULT_GROUP_COLORS.length]!;
    state.groups.push({ id: nextId(), query: "", color, enabled: true });
    schedulePersistUiPrefs();
    renderGroupsList();
    const lastInput = groupsListEl.querySelector<HTMLInputElement>("div:last-child input[type='text']");
    lastInput?.focus();
  });

  renderGroupsList();
  appendNodes(groupsSec.body, groupsListEl, addGroupBtn);

  // Section 4: Display
  const displaySec = createSection(copy.sectionDisplay, true);
  const cbArrows = makeCheckbox("display-arrows", copy.displayArrows, state.display.showArrows, (checked) => {
    state.display.showArrows = checked;
    renderer.setDisplay(state.display);
  });
  const slTextFade = makeSlider(
    "display-fade",
    copy.displayTextFade,
    -2,
    2,
    0.1,
    state.display.textFadeThreshold,
    (v) => v.toFixed(1),
    (val) => {
      state.display.textFadeThreshold = val;
      schedulePersistUiPrefs();
      renderer.setDisplay(state.display);
    },
  );
  const slNodeSize = makeSlider(
    "display-nodesize",
    copy.displayNodeSize,
    0.5,
    2.5,
    0.1,
    state.display.nodeSize,
    (v) => `${v.toFixed(1)}×`,
    (val) => {
      state.display.nodeSize = val;
      schedulePersistUiPrefs();
      rebuildGraph();
    },
  );
  const slLinkThick = makeSlider(
    "display-linkthick",
    copy.displayLinkThickness,
    0.4,
    3,
    0.1,
    state.display.linkThickness,
    (v) => `${v.toFixed(1)}×`,
    (val) => {
      state.display.linkThickness = val;
      schedulePersistUiPrefs();
      renderer.setDisplay(state.display);
    },
  );
  animateSidebarBtn = document.createElement("button");
  animateSidebarBtn.type = "button";
  animateSidebarBtn.className = "ee-gv-btn";
  animateSidebarBtn.textContent = copy.actionAnimate;
  animateSidebarBtn.addEventListener("click", () => {
    renderer.toggleTimelapse();
    animateSidebarBtn.textContent = renderer.isTimelapseRunning() ? copy.actionStopAnimate : copy.actionAnimate;
  });
  appendNodes(displaySec.body, cbArrows.label, slTextFade.wrap, slNodeSize.wrap, slLinkThick.wrap, animateSidebarBtn);

  // Section 5: Forces
  const forcesSec = createSection(copy.sectionForces, false);
  const slCenter = makeSlider(
    "force-center",
    copy.forceCenter,
    0,
    1,
    0.05,
    state.forces.centerForce,
    (v) => v.toFixed(2),
    (val) => {
      state.forces.centerForce = val;
      schedulePersistUiPrefs();
      simulation.setForces(state.forces, true);
      renderer.scheduleFrame();
    },
  );
  const slRepel = makeSlider(
    "force-repel",
    copy.forceRepel,
    1,
    22,
    0.5,
    state.forces.repelForce,
    (v) => v.toFixed(1),
    (val) => {
      state.forces.repelForce = val;
      schedulePersistUiPrefs();
      simulation.setForces(state.forces, true);
      renderer.scheduleFrame();
    },
  );
  const slLinkForce = makeSlider(
    "force-link",
    copy.forceLink,
    0.1,
    2,
    0.05,
    state.forces.linkForce,
    (v) => v.toFixed(2),
    (val) => {
      state.forces.linkForce = val;
      schedulePersistUiPrefs();
      simulation.setForces(state.forces, true);
      renderer.scheduleFrame();
    },
  );
  const slDistance = makeSlider(
    "force-distance",
    copy.forceDistance,
    40,
    280,
    5,
    state.forces.linkDistance,
    (v) => `${Math.round(v)}`,
    (val) => {
      state.forces.linkDistance = val;
      schedulePersistUiPrefs();
      simulation.setForces(state.forces, true);
      renderer.scheduleFrame();
    },
  );
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

  // Section 6: Accessible Visible Nodes list
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

  appendNodes(
    sidebar,
    localSec.details,
    filtersSec.details,
    groupsSec.details,
    displaySec.details,
    forcesSec.details,
    nodesSec.details,
    helpHint,
  );

  const syncWorkspace = async (forceFull = false) => {
    try {
      isLoading = true;
      statsPill.textContent = copy.loadingLabel;
      await indexer.syncIndex({
        maxNotes: state.maxNotes,
        includeAttachments: state.filters.showAttachments,
        forceFull,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) return;
      isLoading = false;
      if (state.mode === "local" && !state.focusNoteId) {
        const activeId = await indexer.resolveActiveNoteId();
        state.focusNoteId = activeId ?? indexer.getSnapshot().notes[0]?.id ?? null;
      }
      rebuildGraph({ fitIfFirst: true });
    } catch (error) {
      if (abortController.signal.aborted) return;
      isLoading = false;
      const msg = error instanceof Error ? error.message : String(error);
      context.ui.showNotice(copy.noticeRefreshFailed(msg));
      rebuildGraph();
    }
  };

  const unsubscribeIndexer = indexer.subscribe(() => {
    if (!isLoading) rebuildGraph();
  });

  const unsubscribeSettings = context.events.on("settings.changed", async ({ key }) => {
    if (key === "filters.show-tags") {
      state.filters.showTags = await readBooleanSetting(context, key, false);
    } else if (key === "filters.show-attachments") {
      state.filters.showAttachments = await readBooleanSetting(context, key, false);
      if (state.filters.showAttachments) await indexer.ensureAttachmentsLoaded(abortController.signal);
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
      void syncWorkspace(false);
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
  void syncWorkspace(false);

  return () => {
    abortController.abort();
    if (savePrefsTimer) clearTimeout(savePrefsTimer);
    unsubscribeIndexer();
    unsubscribeSettings();
    renderer.destroy();
    root.remove();
  };
};
