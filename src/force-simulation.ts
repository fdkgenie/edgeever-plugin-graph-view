import type { GraphEdge, GraphForcesState, GraphNode } from "./types";

export interface SimNode {
  id: string;
  radius: number;
  degree: number;
  hopDistance?: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

export interface SimEdge {
  id: string;
  source: SimNode;
  target: SimNode;
}

interface QuadNode {
  x: number;
  y: number;
  size: number;
  mass: number;
  cx: number;
  cy: number;
  body: SimNode | null;
  children: [QuadNode, QuadNode, QuadNode, QuadNode] | null;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const BARNES_HUT_THETA = 0.75;
const QUADTREE_THRESHOLD = 80;
const MAX_QUADTREE_DEPTH = 24;

const hashStringUnit = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
};

const createQuadNode = (x: number, y: number, size: number): QuadNode => ({
  x,
  y,
  size,
  mass: 0,
  cx: 0,
  cy: 0,
  body: null,
  children: null,
});

const insertBody = (quad: QuadNode, body: SimNode, depth = 0) => {
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
    if (depth >= MAX_QUADTREE_DEPTH) return;
    const half = quad.size * 0.5;
    quad.children = [
      createQuadNode(quad.x, quad.y, half),
      createQuadNode(quad.x + half, quad.y, half),
      createQuadNode(quad.x, quad.y + half, half),
      createQuadNode(quad.x + half, quad.y + half, half),
    ];
    const existing = quad.body;
    quad.body = null;
    placeIntoChild(quad, existing, depth + 1);
    placeIntoChild(quad, body, depth + 1);
    return;
  }

  placeIntoChild(quad, body, depth + 1);
};

const placeIntoChild = (quad: QuadNode, body: SimNode, depth: number) => {
  if (!quad.children) return;
  const half = quad.size * 0.5;
  const right = body.x >= quad.x + half ? 1 : 0;
  const bottom = body.y >= quad.y + half ? 2 : 0;
  insertBody(quad.children[right + bottom]!, body, depth);
};

const buildQuadtree = (nodes: readonly SimNode[]): QuadNode | null => {
  if (!nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 64) + 32;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const root = createQuadNode(cx - span * 0.5, cy - span * 0.5, span);
  for (const node of nodes) insertBody(root, node);
  return root;
};

export class ForceSimulation {
  nodes: SimNode[] = [];
  edges: SimEdge[] = [];
  nodeMap = new Map<string, SimNode>();
  alpha = 1;
  alphaMin = 0.002;
  alphaDecay = 0.024;
  alphaTarget = 0;
  velocityDecay = 0.62;
  private forces: GraphForcesState;

  constructor(forces: GraphForcesState) {
    this.forces = { ...forces };
  }

  setForces(forces: GraphForcesState, reheat = false) {
    this.forces = { ...forces };
    if (reheat) this.reheat(0.65);
  }

  reheat(alpha = 0.85) {
    this.alpha = Math.max(this.alpha, alpha);
  }

  setGraph(
    graphNodes: readonly GraphNode[],
    graphEdges: readonly GraphEdge[],
    options?: { preservePositions?: boolean; reheatAlpha?: number },
  ) {
    const preserve = options?.preservePositions !== false;
    const prevMap = preserve ? this.nodeMap : new Map<string, SimNode>();
    const nextMap = new Map<string, SimNode>();

    // First pass: keep existing positions
    const newNodes: SimNode[] = [];
    const pendingNew: GraphNode[] = [];

    for (let i = 0; i < graphNodes.length; i += 1) {
      const gn = graphNodes[i]!;
      const prev = prevMap.get(gn.id);
      if (prev) {
        const simNode: SimNode = {
          id: gn.id,
          radius: gn.radius,
          degree: gn.degree,
          hopDistance: gn.hopDistance,
          x: prev.x,
          y: prev.y,
          vx: prev.vx * 0.5,
          vy: prev.vy * 0.5,
          fx: prev.fx,
          fy: prev.fy,
        };
        nextMap.set(gn.id, simNode);
        newNodes.push(simNode);
      } else {
        pendingNew.push(gn);
      }
    }

    // Build quick neighbor position lookup for newly introduced nodes
    const neighborPos = new Map<string, { x: number; y: number }>();
    for (const edge of graphEdges) {
      const src = nextMap.get(edge.source);
      const tgt = nextMap.get(edge.target);
      if (src && !nextMap.has(edge.target) && !neighborPos.has(edge.target)) {
        neighborPos.set(edge.target, { x: src.x, y: src.y });
      } else if (tgt && !nextMap.has(edge.source) && !neighborPos.has(edge.source)) {
        neighborPos.set(edge.source, { x: tgt.x, y: tgt.y });
      }
    }

    for (let i = 0; i < pendingNew.length; i += 1) {
      const gn = pendingNew[i]!;
      const index = newNodes.length;
      const hash = hashStringUnit(gn.id);
      let x: number;
      let y: number;

      if (gn.hopDistance === 0) {
        x = 0;
        y = 0;
      } else if (neighborPos.has(gn.id)) {
        const anchor = neighborPos.get(gn.id)!;
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

      const simNode: SimNode = {
        id: gn.id,
        radius: gn.radius,
        degree: gn.degree,
        hopDistance: gn.hopDistance,
        x,
        y,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      };
      nextMap.set(gn.id, simNode);
      newNodes.push(simNode);
    }

    const nextEdges: SimEdge[] = [];
    for (const ge of graphEdges) {
      const source = nextMap.get(ge.source);
      const target = nextMap.get(ge.target);
      if (source && target && source !== target) {
        nextEdges.push({ id: ge.id, source, target });
      }
    }

    const topologyChanged =
      pendingNew.length > 0
      || prevMap.size !== nextMap.size
      || this.edges.length !== nextEdges.length;

    this.nodes = newNodes;
    this.edges = nextEdges;
    this.nodeMap = nextMap;

    if (options?.reheatAlpha !== undefined) {
      this.alpha = options.reheatAlpha;
    } else if (topologyChanged || !preserve) {
      this.alpha = Math.max(this.alpha, 0.78);
    }
  }

  pinNode(nodeId: string, x: number, y: number) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    node.fx = x;
    node.fy = y;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
  }

  unpinNode(nodeId: string) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    node.fx = null;
    node.fy = null;
  }

  isSettled(): boolean {
    return this.alpha < this.alphaMin && this.alphaTarget === 0;
  }

  step(): boolean {
    if (this.nodes.length === 0) return false;
    if (this.isSettled()) return false;

    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const alpha = this.alpha;

    // 1. Center force
    const centerPull = this.forces.centerForce * 0.048 * alpha;
    if (centerPull > 0) {
      for (const node of this.nodes) {
        const weight = node.hopDistance === 0 ? 2.4 : 1;
        node.vx -= node.x * centerPull * weight;
        node.vy -= node.y * centerPull * weight;
      }
    }

    // 2. Repel force (exact pairwise for small graphs, Barnes-Hut quadtree for larger graphs)
    const repelStrength = this.forces.repelForce * 28 * alpha;
    if (repelStrength > 0) {
      if (this.nodes.length <= QUADTREE_THRESHOLD) {
        this.applyExactRepulsion(repelStrength);
      } else {
        this.applyQuadtreeRepulsion(repelStrength);
      }
    }

    // 3. Link spring force
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
        const force = ((dist - baseDistance) / dist) * linkStrength * degreeFactor;
        const fx = dx * force;
        const fy = dy * force;
        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }
    }

    // 4. Integrate with damping and speed clamping
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

  tick(iterations: number) {
    for (let i = 0; i < iterations; i += 1) {
      if (!this.step()) break;
    }
  }

  private applyExactRepulsion(repelStrength: number) {
    const count = this.nodes.length;
    for (let i = 0; i < count; i += 1) {
      const a = this.nodes[i]!;
      for (let j = i + 1; j < count; j += 1) {
        const b = this.nodes[j]!;
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
          push += ((minDist - dist) / dist) * 0.35;
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

  private applyQuadtreeRepulsion(repelStrength: number) {
    const tree = buildQuadtree(this.nodes);
    if (!tree) return;
    for (const node of this.nodes) {
      this.accumulateQuadForce(tree, node, repelStrength);
    }
  }

  private accumulateQuadForce(quad: QuadNode, node: SimNode, repelStrength: number) {
    if (quad.mass === 0) return;
    if (quad.body === node && !quad.children) return;

    let dx = quad.cx - node.x;
    let dy = quad.cy - node.y;
    let distSq = dx * dx + dy * dy;
    const dist = Math.sqrt(distSq);

    if (!quad.children || (quad.size / Math.max(dist, 1)) < BARNES_HUT_THETA) {
      if (distSq < 0.01) {
        const angle = hashStringUnit(node.id) * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distSq = 1;
      }
      const clampedSq = Math.max(distSq, 25);
      let push = (repelStrength * quad.mass) / clampedSq;
      if (quad.body && quad.body !== node) {
        const minDist = node.radius + quad.body.radius + 10;
        if (dist > 0.001 && dist < minDist) {
          push += ((minDist - dist) / dist) * 0.35;
        }
      }
      node.vx -= dx * push;
      node.vy -= dy * push;
      return;
    }

    for (const child of quad.children) {
      if (child.mass > 0) this.accumulateQuadForce(child, node, repelStrength);
    }
  }
}
