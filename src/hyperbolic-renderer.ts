import {
  Anchor,
  Arc,
  Isom,
  geodesicArc,
  movePointToPoint,
  type RegularAddress,
} from "hyperbolic-map";

import { CellState, isOpened, openedClue, type GameModel } from "./model";
import {
  hyperbolicTopologyRegistry,
  type HyperbolicCellEntry,
} from "./hyperbolic";
import type { WorldPoint } from "./topology";

export interface HyperbolicViewState {
  version: 1;
  anchorPath: number[];
  matrix: [number, number, number, number];
}

export interface HyperbolicRenderTheme {
  background: string;
  cell: string;
  cellBorder: string;
  marked: string;
  ink: string;
  flag: string;
  question: string;
  exploded: string;
  mine: string;
  numbers: readonly string[];
}

export interface HyperbolicFrameStats {
  visibleCells: number;
  drawnCells: number;
  frontierCells: number;
  frontierEdges: number;
  frameMs: number;
}

interface VisibleNode {
  address: RegularAddress;
  entry: HyperbolicCellEntry;
  path: number[];
  relativeFrame: Isom;
  net: Isom;
  center: WorldPoint;
  points: WorldPoint[];
  polygon: WorldPoint[];
  path2d: Path2D;
  pixelDiameter: number;
  distanceFromCenter: number;
}

const MIN_HYPERBOLIC_ZOOM = 0.4;
const MAX_HYPERBOLIC_ZOOM = 2.2;
const MAX_VISIBLE_TILES = 384;
const DISK_MARGIN = 0.965;
const pointKey = (x: number, y: number): string => `${x},${y}`;

export class HyperbolicFieldRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;

  private anchor: Anchor<RegularAddress> = hyperbolicTopologyRegistry.createAnchor();
  private anchorPath: number[] = [];
  private view = Isom.identity();
  private width = 1;
  private height = 1;
  private dpr = 1;
  private nodesByRef = new Map<string, VisibleNode>();
  private readonly pickFrames = new Map<string, Isom>();
  private readonly arc = new Arc();

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!context) throw new Error("2D canvas is required for the hyperbolic field");
    this.canvas = canvas;
    this.context = context;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
  }

  radius(zoom: number): number {
    return Math.max(1, (Math.min(this.width, this.height) * DISK_MARGIN * zoom) / 2);
  }

  centralCellPixels(zoom: number): number {
    const circumradius = Math.tanh(hyperbolicTopologyRegistry.tiling.metrics.circumradius / 2);
    return this.radius(zoom) * circumradius * 2;
  }

  containsScreenPoint(screenX: number, screenY: number, zoom: number): boolean {
    return Math.hypot(screenX - this.width / 2, screenY - this.height / 2) <= this.radius(zoom);
  }

  home(): void {
    this.anchorPath = [];
    this.anchor = hyperbolicTopologyRegistry.createAnchor();
    this.view = Isom.identity();
    this.nodesByRef.clear();
    this.pickFrames.clear();
  }

  createViewState(): HyperbolicViewState {
    return {
      version: 1,
      anchorPath: [...this.anchorPath],
      matrix: [this.view.ar, this.view.ai, this.view.br, this.view.bi],
    };
  }

  restoreViewState(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const state = value as Partial<HyperbolicViewState>;
    if (
      state.version !== 1 ||
      !Array.isArray(state.anchorPath) ||
      state.anchorPath.length > 16_384 ||
      !state.anchorPath.every(
        (generator) =>
          Number.isInteger(generator) &&
          generator >= 0 &&
          generator < hyperbolicTopologyRegistry.tiling.generatorCount(),
      ) ||
      !Array.isArray(state.matrix) ||
      state.matrix.length !== 4 ||
      !state.matrix.every(Number.isFinite)
    ) {
      return false;
    }
    const matrix = new Isom(state.matrix[0], state.matrix[1], state.matrix[2], state.matrix[3]);
    if (Anchor.maxEntry(matrix) > 1e4 || Math.abs(matrix.detError()) > 1e-5) return false;
    try {
      this.anchorPath = [...state.anchorPath];
      this.anchor = hyperbolicTopologyRegistry.createAnchor(this.anchorPath);
      this.view = matrix;
      this.reanchor();
      this.nodesByRef.clear();
      this.pickFrames.clear();
      return true;
    } catch {
      this.home();
      return false;
    }
  }

  panBy(deltaX: number, deltaY: number, zoom: number, rotationDegrees: number): void {
    const radius = this.radius(zoom);
    const target = this.screenVectorToDisplayDisk(deltaX, deltaY, radius);
    const translation = movePointToPoint(0, 0, target.x, target.y);
    this.view = this.removeDisplayRotation(translation, rotationDegrees).mul(this.view).normalize();
    this.reanchor();
  }

  zoomAt(
    screenX: number,
    screenY: number,
    oldZoom: number,
    requestedZoom: number,
    rotationDegrees: number,
  ): number {
    const nextZoom = Math.max(MIN_HYPERBOLIC_ZOOM, Math.min(MAX_HYPERBOLIC_ZOOM, requestedZoom));
    if (nextZoom === oldZoom) return oldZoom;
    const offsetX = screenX - this.width / 2;
    const offsetY = screenY - this.height / 2;
    const oldPoint = this.screenVectorToDisplayDisk(offsetX, offsetY, this.radius(oldZoom));
    const nextPoint = this.screenVectorToDisplayDisk(offsetX, offsetY, this.radius(nextZoom));
    const oldLength = Math.hypot(oldPoint.x, oldPoint.y);
    const nextLength = Math.hypot(nextPoint.x, nextPoint.y);
    if (oldLength < 0.999 && nextLength < 0.999) {
      const translation = movePointToPoint(oldPoint.x, oldPoint.y, nextPoint.x, nextPoint.y);
      this.view = this.removeDisplayRotation(translation, rotationDegrees).mul(this.view).normalize();
      this.reanchor();
    }
    return nextZoom;
  }

  screenToCell(screenX: number, screenY: number, zoom: number, rotationDegrees: number): HyperbolicCellEntry {
    const radius = this.radius(zoom);
    const displayPoint = this.screenVectorToDisplayDisk(screenX - this.width / 2, screenY - this.height / 2, radius);
    const length = Math.hypot(displayPoint.x, displayPoint.y);
    if (length >= 0.999_999) {
      const scale = 0.999_999 / Math.max(length, 1e-12);
      displayPoint.x *= scale;
      displayPoint.y *= scale;
    }
    const rotation = Isom.rotation((-rotationDegrees * Math.PI) / 180);
    const baseDisk = rotation.inverse().applyToDisk(displayPoint.x, displayPoint.y, [0, 0]);
    const cameraDisk = this.view.inverse().applyToDisk(baseDisk[0], baseDisk[1], [0, 0]);
    const scale = 1 / Math.sqrt(Math.max(1e-300, 1 - cameraDisk[0] ** 2 - cameraDisk[1] ** 2));
    const located = hyperbolicTopologyRegistry.locateFrom(
      this.anchorPath,
      cameraDisk[0] * scale,
      cameraDisk[1] * scale,
    );
    this.pickFrames.set(pointKey(located.entry.x, located.entry.y), located.relativeFrame);
    return located.entry;
  }

  cellScreenPolygon(x: number, y: number, zoom: number, rotationDegrees: number): WorldPoint[] {
    const key = pointKey(x, y);
    const visible = this.nodesByRef.get(key);
    if (visible) return visible.polygon.map((point) => ({ ...point }));
    const relative = this.pickFrames.get(key);
    if (!relative) return [];
    const net = this.displayMatrix(rotationDegrees).mul(relative);
    return this.projectBoundary(net, this.radius(zoom)).polygon;
  }

  render(
    model: GameModel,
    zoom: number,
    rotationDegrees: number,
    fogMode: "off" | "edge" | "cell",
    theme: HyperbolicRenderTheme,
  ): HyperbolicFrameStats {
    const startedAt = performance.now();
    const context = this.context;
    const radius = this.radius(zoom);
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.fillStyle = theme.background;
    context.fillRect(0, 0, this.width, this.height);
    context.save();
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.clip();

    const visible = this.collectVisibleNodes(radius, rotationDegrees);
    this.nodesByRef = new Map(visible.map((node) => [pointKey(node.entry.x, node.entry.y), node]));
    const frontier = new Set<string>();
    const edgeFrontier = new Map<string, Set<number>>();
    for (const node of visible) {
      const state = model.getState(node.entry.x, node.entry.y);
      if (!isOpened(state) && state !== CellState.Exploded) continue;
      if (fogMode === "cell") {
        model.topology.forEachNeighbor(node.entry.x, node.entry.y, (neighborX, neighborY) => {
          if (model.getState(neighborX, neighborY) === CellState.Covered) frontier.add(pointKey(neighborX, neighborY));
        });
      } else if (fogMode === "edge") {
        const edges = model.topology.edgeNeighbors(node.entry.x, node.entry.y);
        for (let edge = 0; edge < edges.length; edge += 1) {
          const neighbor = edges[edge];
          if (model.getState(neighbor.x, neighbor.y) !== CellState.Covered) continue;
          const list = edgeFrontier.get(pointKey(node.entry.x, node.entry.y)) ?? new Set<number>();
          list.add(edge);
          edgeFrontier.set(pointKey(node.entry.x, node.entry.y), list);
        }
      }
    }

    const drawn = visible
      .filter((node) => model.getState(node.entry.x, node.entry.y) !== CellState.Covered || frontier.has(pointKey(node.entry.x, node.entry.y)))
      .sort((left, right) => right.distanceFromCenter - left.distanceFromCenter);

    for (const node of drawn) {
      const state = model.getState(node.entry.x, node.entry.y);
      context.fillStyle =
        state === CellState.Covered
          ? theme.background
          : state === CellState.Flagged || state === CellState.Question
            ? theme.marked
            : state === CellState.Exploded
              ? theme.exploded
              : theme.cell;
      context.fill(node.path2d);
    }
    context.strokeStyle = theme.cellBorder;
    context.lineWidth = 1;
    context.lineJoin = "round";
    for (const node of drawn) context.stroke(node.path2d);
    for (const [key, edges] of edgeFrontier) {
      const node = this.nodesByRef.get(key);
      if (!node) continue;
      for (const edge of edges) this.traceEdge(context, node.points, edge, radius);
      context.stroke();
    }

    for (const node of drawn) {
      const state = model.getState(node.entry.x, node.entry.y);
      if (node.pixelDiameter < 14 || state === CellState.Covered) continue;
      this.drawGlyph(context, node.center, node.pixelDiameter, state, theme);
    }
    context.restore();

    context.strokeStyle = theme.cellBorder;
    context.lineWidth = 1;
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.stroke();

    return {
      visibleCells: visible.length,
      drawnCells: drawn.length,
      frontierCells: frontier.size,
      frontierEdges: [...edgeFrontier.values()].reduce((sum, edges) => sum + edges.size, 0),
      frameMs: performance.now() - startedAt,
    };
  }

  copyScreenBounds(
    target: CanvasRenderingContext2D,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): { sourceX: number; sourceY: number; width: number; height: number } {
    const sourceX = Math.max(0, Math.min(this.width - 1, left));
    const sourceY = Math.max(0, Math.min(this.height - 1, top));
    const width = Math.max(1, Math.min(this.width - sourceX, right - sourceX));
    const height = Math.max(1, Math.min(this.height - sourceY, bottom - sourceY));
    const pixelWidth = Math.max(1, Math.ceil(width * this.dpr));
    const pixelHeight = Math.max(1, Math.ceil(height * this.dpr));
    if (target.canvas.width !== pixelWidth) target.canvas.width = pixelWidth;
    if (target.canvas.height !== pixelHeight) target.canvas.height = pixelHeight;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.drawImage(
      this.canvas,
      Math.floor(sourceX * this.dpr),
      Math.floor(sourceY * this.dpr),
      pixelWidth,
      pixelHeight,
      0,
      0,
      pixelWidth,
      pixelHeight,
    );
    return { sourceX, sourceY, width, height };
  }

  drawOverview(target: HTMLCanvasElement, theme: HyperbolicRenderTheme, openedCells: number): string {
    const context = target.getContext("2d");
    if (!context) return "Overview unavailable";
    const cssWidth = Math.max(280, Math.round(target.getBoundingClientRect().width));
    const cssHeight = Math.max(220, Math.round(target.getBoundingClientRect().height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    target.width = Math.round(cssWidth * dpr);
    target.height = Math.round(cssHeight * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = theme.background;
    context.fillRect(0, 0, cssWidth, cssHeight);
    const scale = Math.min(cssWidth / this.width, cssHeight / this.height);
    const drawWidth = this.width * scale;
    const drawHeight = this.height * scale;
    context.drawImage(this.canvas, (cssWidth - drawWidth) / 2, (cssHeight - drawHeight) / 2, drawWidth, drawHeight);
    return `Hyperbolic pentagons · ${openedCells.toLocaleString()} revealed`;
  }

  private displayMatrix(rotationDegrees: number): Isom {
    return Isom.rotation((-rotationDegrees * Math.PI) / 180).mul(this.view);
  }

  private removeDisplayRotation(displayTransform: Isom, rotationDegrees: number): Isom {
    const rotation = Isom.rotation((-rotationDegrees * Math.PI) / 180);
    return rotation.inverse().mul(displayTransform).mul(rotation);
  }

  private screenVectorToDisplayDisk(deltaX: number, deltaY: number, radius: number): WorldPoint {
    return { x: deltaX / radius, y: -deltaY / radius };
  }

  private reanchor(): void {
    const tiling = hyperbolicTopologyRegistry.tiling;
    for (let step = 0; step < 128; step += 1) {
      const center = this.anchor.viewCenterLocal(this.view, [0, 0, 0]);
      const direction = tiling.stepToward(center[0], center[1]);
      if (direction < 0) return;
      const neighbors = tiling.neighbors(this.anchor.address);
      if (direction >= neighbors.length) return;
      const chosen = neighbors[direction];
      const frame = tiling.stepFrame(this.anchor.address, chosen.gen);
      this.view = this.view.mul(frame).normalize();
      this.anchor.address = chosen.address;
      this.anchorPath.push(chosen.gen);
      hyperbolicTopologyRegistry.register(chosen.address, this.anchorPath);
    }
    throw new Error("Hyperbolic camera could not settle on a nearby pentagon");
  }

  private collectVisibleNodes(radius: number, rotationDegrees: number): VisibleNode[] {
    const tiling = hyperbolicTopologyRegistry.tiling;
    const display = this.displayMatrix(rotationDegrees);
    const queue: Array<{ address: RegularAddress; path: number[]; relativeFrame: Isom }> = [
      { address: this.anchor.address, path: [...this.anchorPath], relativeFrame: Isom.identity() },
    ];
    const seen = new Set<string>();
    const output: VisibleNode[] = [];
    let cursor = 0;
    while (cursor < queue.length && seen.size < MAX_VISIBLE_TILES) {
      const candidate = queue[cursor++];
      const id = tiling.addressKey(candidate.address);
      if (seen.has(id)) continue;
      seen.add(id);
      const net = display.mul(candidate.relativeFrame);
      const projected = this.projectBoundary(net, radius);
      const entry = hyperbolicTopologyRegistry.register(candidate.address, candidate.path);
      const node: VisibleNode = {
        ...candidate,
        entry,
        net,
        ...projected,
        path2d: this.createBoundaryPath(projected.points, radius),
        distanceFromCenter: Math.hypot(projected.center.x - this.width / 2, projected.center.y - this.height / 2),
      };
      if (
        projected.pixelDiameter >= 0.45 &&
        projected.polygon.some(
          (point) => point.x >= -2 && point.x <= this.width + 2 && point.y >= -2 && point.y <= this.height + 2,
        )
      ) {
        output.push(node);
      }
      if (projected.pixelDiameter < 0.45) continue;
      for (const neighbor of tiling.neighbors(candidate.address)) {
        const neighborId = tiling.addressKey(neighbor.address);
        if (seen.has(neighborId)) continue;
        queue.push({
          address: neighbor.address,
          path: [...candidate.path, neighbor.gen],
          relativeFrame: candidate.relativeFrame.mul(tiling.stepFrame(candidate.address, neighbor.gen)),
        });
      }
    }
    return output;
  }

  private projectBoundary(
    net: Isom,
    radius: number,
  ): { center: WorldPoint; points: WorldPoint[]; polygon: WorldPoint[]; pixelDiameter: number } {
    const centerDisk = net.applyToDisk(0, 0, [0, 0]);
    const center = { x: this.width / 2 + centerDisk[0] * radius, y: this.height / 2 - centerDisk[1] * radius };
    const points = hyperbolicTopologyRegistry.boundary.map(([x, y]) => {
      const point = net.applyToLocal(x, y, undefined, [0, 0]);
      return { x: point[0], y: point[1] };
    });
    const polygon = this.sampleBoundary(points, radius);
    let pixelDiameter = 0;
    for (const point of polygon) pixelDiameter = Math.max(pixelDiameter, Math.hypot(point.x - center.x, point.y - center.y) * 2);
    return { center, points, polygon, pixelDiameter };
  }

  private createBoundaryPath(points: readonly WorldPoint[], radius: number): Path2D {
    const path = new Path2D();
    path.moveTo(this.width / 2 + points[0].x * radius, this.height / 2 - points[0].y * radius);
    for (let edge = 0; edge < points.length; edge += 1) this.appendEdge(path, points, edge, radius);
    path.closePath();
    return path;
  }

  private traceEdge(context: CanvasRenderingContext2D, points: readonly WorldPoint[], edge: number, radius: number): void {
    const start = points[edge];
    context.beginPath();
    context.moveTo(this.width / 2 + start.x * radius, this.height / 2 - start.y * radius);
    this.appendEdge(context, points, edge, radius);
  }

  private appendEdge(
    context: CanvasRenderingContext2D | Path2D,
    points: readonly WorldPoint[],
    edge: number,
    radius: number,
  ): void {
    const start = points[edge];
    const end = points[(edge + 1) % points.length];
    geodesicArc(start.x, start.y, end.x, end.y, this.arc, 0.2 / radius);
    if (this.arc.straight) {
      context.lineTo(this.width / 2 + end.x * radius, this.height / 2 - end.y * radius);
    } else {
      context.arc(
        this.width / 2 + this.arc.cx * radius,
        this.height / 2 - this.arc.cy * radius,
        this.arc.r * radius,
        -this.arc.startAngle,
        -this.arc.endAngle,
        this.arc.anticlockwise,
      );
    }
  }

  private sampleBoundary(points: readonly WorldPoint[], radius: number): WorldPoint[] {
    const polygon: WorldPoint[] = [];
    for (let edge = 0; edge < points.length; edge += 1) {
      const start = points[edge];
      const end = points[(edge + 1) % points.length];
      geodesicArc(start.x, start.y, end.x, end.y, this.arc, 0);
      if (this.arc.straight) {
        polygon.push({ x: this.width / 2 + start.x * radius, y: this.height / 2 - start.y * radius });
        continue;
      }
      let delta = this.arc.endAngle - this.arc.startAngle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta <= -Math.PI) delta += Math.PI * 2;
      const steps = Math.max(2, Math.min(24, Math.ceil(Math.abs(delta) * Math.sqrt(Math.max(1, this.arc.r * radius)))));
      for (let step = 0; step < steps; step += 1) {
        const angle = this.arc.startAngle + (delta * step) / steps;
        polygon.push({
          x: this.width / 2 + (this.arc.cx + Math.cos(angle) * this.arc.r) * radius,
          y: this.height / 2 - (this.arc.cy + Math.sin(angle) * this.arc.r) * radius,
        });
      }
    }
    return polygon;
  }

  private drawGlyph(
    context: CanvasRenderingContext2D,
    center: WorldPoint,
    diameter: number,
    state: CellState,
    theme: HyperbolicRenderTheme,
  ): void {
    const fontSize = Math.max(9, Math.min(42, diameter * 0.27));
    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `750 ${fontSize}px Inter, sans-serif`;
    if (isOpened(state)) {
      const clue = openedClue(state);
      if (clue > 0) {
        context.fillStyle = theme.numbers[Math.min(clue, theme.numbers.length - 1)] ?? theme.ink;
        context.fillText(String(clue), center.x, center.y + fontSize * 0.03);
      }
    } else if (state === CellState.Flagged) {
      context.fillStyle = theme.flag;
      context.fillText("⚑", center.x, center.y);
    } else if (state === CellState.Question) {
      context.fillStyle = theme.question;
      context.fillText("?", center.x, center.y);
    } else if (state === CellState.Exploded) {
      context.fillStyle = theme.mine;
      context.beginPath();
      context.arc(center.x, center.y, fontSize * 0.23, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = theme.mine;
      context.lineWidth = Math.max(1, fontSize * 0.08);
      for (let index = 0; index < 8; index += 1) {
        const angle = (index * Math.PI) / 4;
        context.beginPath();
        context.moveTo(center.x + Math.cos(angle) * fontSize * 0.28, center.y + Math.sin(angle) * fontSize * 0.28);
        context.lineTo(center.x + Math.cos(angle) * fontSize * 0.42, center.y + Math.sin(angle) * fontSize * 0.42);
        context.stroke();
      }
    }
    context.restore();
  }
}
