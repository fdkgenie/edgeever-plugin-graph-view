import { ForceSimulation, type SimNode } from "./force-simulation";
import type { GraphData, GraphDisplayState, GraphNode } from "./types";

interface ThemePalette {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  accent: string;
  nodeDefault: string;
  nodeTag: string;
  nodeAttachment: string;
  nodeUnresolved: string;
  edge: string;
  border: string;
}

const LIGHT_FALLBACK_PALETTE: ThemePalette = {
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
  border: "#cbd5e1",
};

const DARK_FALLBACK_PALETTE: ThemePalette = {
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
  border: "#334155",
};

export interface CanvasRendererOptions {
  rootElement: HTMLElement;
  canvas: HTMLCanvasElement;
  simulation: ForceSimulation;
  onHoverNode: (node: GraphNode | null) => void;
  onActivateNode: (node: GraphNode) => void;
  onFocusLocalNode: (node: GraphNode) => void;
  onTimelapseState?: (state: { running: boolean; current: number; total: number; dateLabel: string }) => void;
}

export class GraphCanvasRenderer {
  private readonly rootElement: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly simulation: ForceSimulation;
  private readonly onHoverNode: (node: GraphNode | null) => void;
  private readonly onActivateNode: (node: GraphNode) => void;
  private readonly onFocusLocalNode: (node: GraphNode) => void;
  private readonly onTimelapseState?: CanvasRendererOptions["onTimelapseState"];

  private graphData: GraphData | null = null;
  private display: GraphDisplayState = {
    showArrows: false,
    textFadeThreshold: 0,
    nodeSize: 1,
    linkThickness: 1,
  };

  private width = 640;
  private height = 420;
  private dpr = 1;
  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private hasFittedInitial = false;

  private hoveredId: string | null = null;
  private selectedId: string | null = null;
  private draggedNodeId: string | null = null;
  private isPanning = false;
  private pointerDownPos = { x: 0, y: 0 };
  private lastPointerPos = { x: 0, y: 0 };
  private pointerMovedDist = 0;
  private activePointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist: number | null = null;

  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private mediaQuery: MediaQueryList | null = null;
  private palette: ThemePalette = LIGHT_FALLBACK_PALETTE;

  // Time-lapse state
  private timelapseRunning = false;
  private timelapseOrder: string[] = [];
  private timelapseProgress = 0;
  private timelapseLastTickMs = 0;

  private readonly disposers: Array<() => void> = [];

  constructor(options: CanvasRendererOptions) {
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

  setGraphData(data: GraphData, display: GraphDisplayState, options?: { fitIfFirst?: boolean }) {
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

    if ((!this.hasFittedInitial && data.nodes.length > 0) || (prevCount === 0 && data.nodes.length > 0 && options?.fitIfFirst !== false)) {
      this.hasFittedInitial = true;
      this.simulation.tick(Math.min(120, 40 + data.nodes.length));
      this.fitToView();
    } else {
      this.scheduleFrame();
    }
  }

  setDisplay(display: GraphDisplayState) {
    this.display = { ...display };
    this.scheduleFrame();
  }

  focusNodeById(nodeId: string | null) {
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

  zoomBy(factor: number, anchorScreen?: { x: number; y: number }) {
    const prevZoom = this.zoom;
    const nextZoom = Math.min(Math.max(prevZoom * factor, 0.12), 5.5);
    if (nextZoom === prevZoom) return;

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
      if (node.x - pad < minX) minX = node.x - pad;
      if (node.y - pad < minY) minY = node.y - pad;
      if (node.x + pad > maxX) maxX = node.x + pad;
      if (node.y + pad > maxY) maxY = node.y + pad;
    }

    const spanW = Math.max(80, maxX - minX);
    const spanH = Math.max(80, maxY - minY);
    const margin = 0.84;
    const fitZoom = Math.min(
      (this.width * margin) / spanW,
      (this.height * margin) / spanH,
      2.2,
    );
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
    if (!this.graphData || this.graphData.nodes.length === 0) return;
    this.timelapseRunning = true;
    this.rebuildTimelapseOrder();
    this.timelapseProgress = 1;
    this.timelapseLastTickMs = performance.now();
    this.emitTimelapseProgress();
    this.scheduleFrame();
  }

  stopTimelapse() {
    if (!this.timelapseRunning) return;
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
    for (const dispose of this.disposers) dispose();
  }

  private rebuildTimelapseOrder() {
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

  private emitTimelapseProgress() {
    if (!this.graphData || !this.timelapseRunning) return;
    const total = this.timelapseOrder.length;
    const current = Math.min(total, Math.max(1, Math.floor(this.timelapseProgress)));
    const currentNodeId = this.timelapseOrder[current - 1];
    const currentNode = currentNodeId ? this.graphData.nodeById.get(currentNodeId) : null;
    const dateLabel = currentNode?.createdAt ? currentNode.createdAt.slice(0, 10) : "";
    this.onTimelapseState?.({ running: true, current, total, dateLabel });
  }

  private isDarkMode(): boolean {
    const docRoot = typeof document !== "undefined" ? document.documentElement : null;
    if (docRoot?.classList.contains("dark")) return true;
    if (docRoot?.classList.contains("light")) return false;
    return Boolean(this.mediaQuery?.matches);
  }

  private refreshPalette() {
    const dark = this.isDarkMode();
    const fallback = dark ? DARK_FALLBACK_PALETTE : LIGHT_FALLBACK_PALETTE;
    if (typeof getComputedStyle !== "function") {
      this.palette = fallback;
      return;
    }
    const styles = getComputedStyle(this.rootElement);
    const readVar = (name: string, fb: string) => {
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
      border: readVar("--ee-gv-border", fallback.border),
    };
  }

  private setupObservers() {
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
        attributeFilter: ["class", "style"],
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

  private measureCanvas() {
    const rect = this.canvas.getBoundingClientRect?.();
    const width = Math.max(240, Math.round(rect?.width || this.canvas.clientWidth || 640));
    const height = Math.max(220, Math.round(rect?.height || this.canvas.clientHeight || 420));
    const dpr = Math.min(typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1, 2.5);
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.scheduleFrame();
  }

  private screenToWorld(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      screenX: sx,
      screenY: sy,
      worldX: (sx - this.width * 0.5 - this.panX) / this.zoom,
      worldY: (sy - this.height * 0.5 - this.panY) / this.zoom,
    };
  }

  private hitTest(worldX: number, worldY: number): SimNode | null {
    const tolerance = 6 / this.zoom;
    for (let i = this.simulation.nodes.length - 1; i >= 0; i -= 1) {
      const node = this.simulation.nodes[i]!;
      const hitRadius = Math.max(node.radius + tolerance, 10 / this.zoom);
      const dx = worldX - node.x;
      const dy = worldY - node.y;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) return node;
    }
    return null;
  }

  private bindEvents() {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      this.canvas.focus({ preventScroll: true });
      this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.canvas.setPointerCapture?.(event.pointerId);

      if (this.activePointers.size === 2) {
        this.draggedNodeId = null;
        this.isPanning = false;
        const pts = [...this.activePointers.values()];
        this.lastPinchDist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
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

    const onPointerMove = (event: PointerEvent) => {
      if (this.activePointers.has(event.pointerId)) {
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      if (this.activePointers.size === 2) {
        const pts = [...this.activePointers.values()];
        const dist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
        if (this.lastPinchDist && dist > 0) {
          const midX = (pts[0]!.x + pts[1]!.x) * 0.5;
          const midY = (pts[0]!.y + pts[1]!.y) * 0.5;
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
        const pos = this.screenToWorld(event.clientX, event.clientY);
        this.simulation.pinNode(this.draggedNodeId, pos.worldX, pos.worldY);
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
        const gn = nextHoveredId ? (this.graphData?.nodeById.get(nextHoveredId) ?? null) : null;
        this.onHoverNode(gn);
        this.scheduleFrame();
      }
    };

    const endPointer = (event: PointerEvent) => {
      this.activePointers.delete(event.pointerId);
      if (this.activePointers.size < 2) this.lastPinchDist = null;

      if (this.draggedNodeId) {
        const activatedId = this.draggedNodeId;
        this.simulation.unpinNode(this.draggedNodeId);
        this.simulation.alphaTarget = 0;
        this.draggedNodeId = null;
        this.canvas.dataset.dragging = "false";

        if (this.pointerMovedDist < 5 && this.graphData) {
          const node = this.graphData.nodeById.get(activatedId);
          if (node) this.onActivateNode(node);
        }
        this.scheduleFrame();
        return;
      }

      if (this.isPanning) {
        this.isPanning = false;
        this.canvas.dataset.dragging = "false";
        if (this.pointerMovedDist < 5 && event.type === "pointerup") {
          const movedFromDown = Math.hypot(
            event.clientX - this.pointerDownPos.x,
            event.clientY - this.pointerDownPos.y,
          );
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
        if (!this.selectedId) this.onHoverNode(null);
        this.scheduleFrame();
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * 0.0014);
      this.zoomBy(factor, anchor);
    };

    const onDblClick = (event: MouseEvent) => {
      const pos = this.screenToWorld(event.clientX, event.clientY);
      const hit = this.hitTest(pos.worldX, pos.worldY);
      if (!hit) {
        this.fitToView();
      } else {
        const node = this.graphData?.nodeById.get(hit.id);
        if (node) this.onFocusLocalNode(node);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
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
        if (node) this.onActivateNode(node);
      } else if ((event.key === "l" || event.key === "L") && this.selectedId) {
        event.preventDefault();
        const node = this.graphData?.nodeById.get(this.selectedId);
        if (node) this.onFocusLocalNode(node);
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

  private cycleSelectedNode(delta: 1 | -1) {
    if (!this.graphData || this.graphData.nodes.length === 0) return;
    const sorted = [...this.graphData.nodes].sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
    const currentIndex = this.selectedId ? sorted.findIndex((item) => item.id === this.selectedId) : -1;
    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + delta + sorted.length) % sorted.length;
    const target = sorted[nextIndex]!;
    this.focusNodeById(target.id);
  }

  scheduleFrame() {
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      this.renderFrame(performance.now());
      return;
    }
    this.rafId = requestAnimationFrame((now) => {
      this.rafId = null;
      this.renderFrame(now);
    });
  }

  private renderFrame(now: number) {
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

  private draw() {
    const ctx = this.canvas.getContext?.("2d");
    if (!ctx || !this.graphData) return;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = this.palette.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.translate(this.width * 0.5 + this.panX, this.height * 0.5 + this.panY);
    ctx.scale(this.zoom, this.zoom);

    const visibleSet = this.timelapseRunning
      ? new Set(this.timelapseOrder.slice(0, Math.max(1, Math.floor(this.timelapseProgress))))
      : null;

    const focusActiveId = this.hoveredId ?? this.selectedId;
    const activeNeighbors = focusActiveId ? this.graphData.neighborsById.get(focusActiveId) ?? null : null;

    // 1. Edges
    const baseLineWidth = Math.max(0.45, this.display.linkThickness) / Math.sqrt(Math.max(this.zoom, 0.5));
    for (const edge of this.graphData.edges) {
      if (visibleSet && (!visibleSet.has(edge.source) || !visibleSet.has(edge.target))) continue;
      const src = this.simulation.nodeMap.get(edge.source);
      const tgt = this.simulation.nodeMap.get(edge.target);
      if (!src || !tgt) continue;

      const isIncident = focusActiveId !== null && (edge.source === focusActiveId || edge.target === focusActiveId);
      ctx.save();
      ctx.globalAlpha = focusActiveId ? (isIncident ? 0.92 : 0.14) : 1;
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

    // 2. Nodes
    for (const simNode of this.simulation.nodes) {
      if (visibleSet && !visibleSet.has(simNode.id)) continue;
      const gn = this.graphData.nodeById.get(simNode.id);
      if (!gn) continue;

      const isPrimary = simNode.id === focusActiveId;
      const isNeighbor = Boolean(activeNeighbors?.has(simNode.id));
      const isDimmed = Boolean(focusActiveId && !isPrimary && !isNeighbor);
      const color = this.resolveNodeColor(gn);

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.18 : 1;
      this.drawNodeShape(ctx, simNode.x, simNode.y, simNode.radius, gn, color, isPrimary);
      ctx.restore();
    }

    // 3. Labels
    const fadeMinZoom = Math.pow(1.45, this.display.textFadeThreshold) * 0.55;
    const baseLabelAlpha = Math.max(0, Math.min(1, (this.zoom - fadeMinZoom * 0.65) / Math.max(0.25, fadeMinZoom * 0.7)));
    const fontSize = Math.max(9.5, Math.min(14, 11.5 / Math.pow(this.zoom, 0.42)));
    ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (const simNode of this.simulation.nodes) {
      if (visibleSet && !visibleSet.has(simNode.id)) continue;
      const gn = this.graphData.nodeById.get(simNode.id);
      if (!gn) continue;

      const isPrimary = simNode.id === focusActiveId;
      const isNeighbor = Boolean(activeNeighbors?.has(simNode.id));
      const isFocalLocal = gn.hopDistance === 0;
      const labelAlpha = isPrimary || isNeighbor || isFocalLocal
        ? 1
        : focusActiveId
          ? Math.min(baseLabelAlpha, 0.14)
          : baseLabelAlpha;

      if (labelAlpha <= 0.04) continue;

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

  private resolveNodeColor(node: GraphNode): string {
    if (node.groupColor) return node.groupColor;
    if (node.hopDistance === 0) return this.palette.accent;
    if (node.nodeType === "tag") return this.palette.nodeTag;
    if (node.nodeType === "attachment") return this.palette.nodeAttachment;
    if (node.nodeType === "unresolved") return this.palette.nodeUnresolved;
    return this.palette.nodeDefault;
  }

  private drawNodeShape(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    node: GraphNode,
    color: string,
    isHighlighted: boolean,
  ) {
    ctx.fillStyle = color;
    ctx.strokeStyle = isHighlighted ? this.palette.accent : this.palette.bg;
    ctx.lineWidth = (isHighlighted ? 2.4 : 1.2) / Math.sqrt(Math.max(this.zoom, 0.6));

    if (node.nodeType === "tag") {
      // Diamond marker so tag nodes are distinguishable without color alone
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
      // Rounded square marker for attachment nodes
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
      // Hollow dashed ring for unresolved links
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

  private drawArrowhead(ctx: CanvasRenderingContext2D, src: SimNode, tgt: SimNode, color: string) {
    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    const dist = Math.hypot(dx, dy);
    if (dist < tgt.radius + 4) return;
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
