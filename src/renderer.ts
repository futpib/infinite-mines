import { CellState, GameModel, STATE_TILE_SIZE, floorDiv, isOpened, type ExploredBounds } from "./model";
import type { ViewSnapshotV1 } from "./persistence";

export interface RenderDiagnostics {
  backend: "webgl2";
  lod: "detail" | "pixel";
  cellSize: number;
  borderCssPixels: 0 | 1;
  glyphs: boolean;
  detailMix: number;
  backgroundColor: string;
  frameCount: number;
  frameMs: number;
  visibleCells: number;
  drawnCells: number;
  chunks: number;
  storedCells: number;
  cachedTiles: number;
  drawCalls: number;
  instanceUploads: number;
  pixelRatio: number;
  hoveredCells: number;
  fps: number | null;
  redrawMode: "full" | "damage" | "pan" | "none";
  redrawnPixels: number;
  blittedPixels: number;
  canvasPixels: number;
  fullRedraws: number;
  damageRedraws: number;
  panRedraws: number;
}

const BASE_CELL_SIZE = 25;
const MIN_CELL_SIZE = 1;
const MIN_ZOOM = MIN_CELL_SIZE / BASE_CELL_SIZE;
const DETAIL_FADE_START = 4;
const DETAIL_FADE_END = 8;
const SPARSE_LOD_THRESHOLD = DETAIL_FADE_START;
const SPARSE_ANCHOR_CELLS = 1024;
const PIXEL_LOD_OVERSCAN_CSS = 256;
const RENDER_TILE_CELLS = STATE_TILE_SIZE;
const CELLS_PER_TILE = RENDER_TILE_CELLS * RENDER_TILE_CELLS;
const CACHED_CELL_FLOATS = 4;
const INSTANCE_FLOATS = 5;
const SPRITE_COUNT = 12;
const SPRITE_PIXELS = 64;
const MAX_CACHED_TILES = 2048;
const MAX_DAMAGE_AREA_RATIO = 0.4;
const PAN_BLIT_MIN_DETAIL_INSTANCES = 20_000;

interface FrameRequest {
  kind: "full" | "damage" | "pan";
  damage?: ExploredBounds;
}

interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RenderTheme {
  background: string;
  backgroundRgb: [number, number, number];
  cell: string;
  cellBorder: string;
  marked: string;
  ink: string;
  flag: string;
  flagStroke: string;
  question: string;
  exploded: string;
  mine: string;
  spark: string;
  artifact: string;
  artifactEdge: string;
  artifactRgb: [number, number, number];
  artifactEdgeRgb: [number, number, number];
  overview: string;
  overviewOpened: string;
  numbers: string[];
}

const hexToRgb = (color: string): [number, number, number] => {
  const value = color.trim().replace("#", "");
  if (!/^[\da-f]{6}$/i.test(value)) throw new Error(`Expected a six-digit theme color, received: ${color}`);
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
};

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_cell;
layout(location = 2) in float a_edges;

uniform vec2 u_viewport;
uniform vec2 u_cameraCell;
uniform float u_cellSize;
uniform float u_dpr;

out vec2 v_cellUv;
flat out float v_sprite;
flat out float v_artifact;
flat out float v_edges;

void main() {
  vec2 start = u_viewport * 0.5 + (a_cell.xy - u_cameraCell) * u_cellSize;
  vec2 end = u_viewport * 0.5 + (a_cell.xy - u_cameraCell + 1.0) * u_cellSize;
  start = floor(start * u_dpr + 0.5) / u_dpr;
  end = floor(end * u_dpr + 0.5) / u_dpr;
  vec2 pixel = mix(start, end, a_corner);
  vec2 clip = pixel / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_cellUv = a_corner;
  v_sprite = a_cell.z;
  v_artifact = a_cell.w;
  v_edges = a_edges;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform vec3 u_artifact;
uniform vec3 u_artifactEdge;
uniform vec3 u_lodArtifact;
uniform vec3 u_cell;
uniform vec3 u_cellBorder;
uniform vec3 u_marked;
uniform vec3 u_exploded;
uniform vec3 u_lodColors[12];
uniform float u_dpr;
uniform float u_cellSize;

in vec2 v_cellUv;
flat in float v_sprite;
flat in float v_artifact;
flat in float v_edges;
out vec4 outColor;

void main() {
  vec3 fill = v_sprite == 11.0 ? u_exploded : (v_sprite >= 9.0 ? u_marked : u_cell);
  vec3 base = fill;
  if (u_cellSize >= 3.0) {
    vec2 pixelWidth = max(fwidth(v_cellUv), vec2(0.000001));
    vec4 edgeDistance = vec4(
      v_cellUv.y / pixelWidth.y,
      v_cellUv.x / pixelWidth.x,
      (1.0 - v_cellUv.x) / pixelWidth.x,
      (1.0 - v_cellUv.y) / pixelWidth.y
    );
    int edges = int(v_edges + 0.5);
    float innerDistance = 100000.0;
    if ((edges & 1) != 0) innerDistance = min(innerDistance, edgeDistance.x);
    if ((edges & 2) != 0) innerDistance = min(innerDistance, edgeDistance.y);
    if ((edges & 4) != 0) innerDistance = min(innerDistance, edgeDistance.z);
    if ((edges & 8) != 0) innerDistance = min(innerDistance, edgeDistance.w);
    float fillMix = smoothstep(u_dpr - 0.5, u_dpr + 0.5, innerDistance);
    base = mix(u_cellBorder, fill, fillMix);
  }

  int stateIndex = int(clamp(v_sprite, 0.0, 11.0) + 0.5);
  vec3 stateColor = v_artifact > 0.5 ? u_lodArtifact : u_lodColors[stateIndex];

  vec2 atlasPixel = vec2(v_sprite * float(${SPRITE_PIXELS}), 0.0) + v_cellUv * float(${SPRITE_PIXELS - 1}) + 0.5;
  vec2 atlasSize = vec2(float(${SPRITE_COUNT * SPRITE_PIXELS}), float(${SPRITE_PIXELS}));
  vec4 glyph = texture(u_atlas, atlasPixel / atlasSize);
  vec4 color = vec4(mix(base, glyph.rgb, glyph.a), 1.0);

  if (v_artifact > 0.5) {
    vec2 centered = v_cellUv - 0.5;
    vec2 rotated = vec2(centered.x + centered.y, centered.y - centered.x) * 0.707107;
    float square = max(abs(rotated.x), abs(rotated.y));
    if (square < 0.27) color = vec4(u_artifactEdge, 1.0);
    if (square < 0.22) color = vec4(u_artifact, 1.0);
  }

  float detailMix = smoothstep(${DETAIL_FADE_START.toFixed(1)}, ${DETAIL_FADE_END.toFixed(1)}, u_cellSize);
  outColor = vec4(mix(stateColor, color.rgb, detailMix), 1.0);
}`;

const PIXEL_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 u_viewport;
uniform vec2 u_cameraCell;
uniform ivec2 u_textureOrigin;
uniform ivec2 u_textureSize;
uniform float u_cellSize;
uniform float u_dpr;

out vec2 v_textureUv;

void main() {
  vec2 corner = vec2(
    gl_VertexID == 1 || gl_VertexID == 4 || gl_VertexID == 5 ? 1.0 : 0.0,
    gl_VertexID == 2 || gl_VertexID == 3 || gl_VertexID == 5 ? 1.0 : 0.0
  );
  vec2 start = u_viewport * 0.5 + (vec2(u_textureOrigin) - u_cameraCell) * u_cellSize;
  vec2 end = start + vec2(u_textureSize) * u_cellSize;
  start = floor(start * u_dpr + 0.5) / u_dpr;
  end = floor(end * u_dpr + 0.5) / u_dpr;
  vec2 pixel = mix(start, end, corner);
  vec2 clip = pixel / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_textureUv = corner;
}`;

const PIXEL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D u_stateTexture;
uniform ivec2 u_textureSize;
uniform vec3 u_lodArtifact;
uniform vec3 u_lodColors[12];

in vec2 v_textureUv;
out vec4 outColor;

void main() {
  ivec2 texel = min(ivec2(floor(v_textureUv * vec2(u_textureSize))), u_textureSize - 1);
  uint encoded = texelFetch(u_stateTexture, texel, 0).r;
  if (encoded == 0u) discard;
  int stateIndex = int((encoded & 15u) - 1u);
  outColor = vec4((encoded & 16u) != 0u ? u_lodArtifact : u_lodColors[stateIndex], 1.0);
}`;

interface CachedTile {
  cells: Float32Array;
  generation: number;
  version: number;
}

interface VisibleTile {
  relativeOriginX: number;
  relativeOriginY: number;
  worldOriginX: number;
  worldOriginY: number;
  cells: Float32Array;
}

interface GlResources {
  program: WebGLProgram;
  pixelProgram: WebGLProgram;
  vertexArray: WebGLVertexArrayObject;
  pixelVertexArray: WebGLVertexArrayObject;
  instanceBuffer: WebGLBuffer;
  atlasTexture: WebGLTexture;
  stateTexture: WebGLTexture;
  scratchTexture: WebGLTexture;
  scratchFramebuffer: WebGLFramebuffer;
  viewportUniform: WebGLUniformLocation;
  cameraCellUniform: WebGLUniformLocation;
  cellSizeUniform: WebGLUniformLocation;
  dprUniform: WebGLUniformLocation;
  artifactUniform: WebGLUniformLocation;
  artifactEdgeUniform: WebGLUniformLocation;
  lodArtifactUniform: WebGLUniformLocation;
  cellUniform: WebGLUniformLocation;
  cellBorderUniform: WebGLUniformLocation;
  markedUniform: WebGLUniformLocation;
  explodedUniform: WebGLUniformLocation;
  lodColorsUniform: WebGLUniformLocation;
  pixelViewportUniform: WebGLUniformLocation;
  pixelCameraCellUniform: WebGLUniformLocation;
  pixelTextureOriginUniform: WebGLUniformLocation;
  pixelTextureSizeUniform: WebGLUniformLocation;
  pixelCellSizeUniform: WebGLUniformLocation;
  pixelDprUniform: WebGLUniformLocation;
  pixelLodArtifactUniform: WebGLUniformLocation;
  pixelLodColorsUniform: WebGLUniformLocation;
}

interface TileRange {
  lod: "detail" | "pixel";
  anchorX: number;
  anchorY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  generation: number;
  version: number;
}

const requireShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${log}`);
  }
  return shader;
};

const requireProgram = (gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram => {
  const vertex = requireShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = requireShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${log}`);
  }
  return program;
};

const requireUniform = (gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation => {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`Missing WebGL uniform: ${name}`);
  return location;
};

export class WebGLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly model: GameModel;
  zoom = 1;
  panX = 0;
  panY = 0;
  diagnostics: RenderDiagnostics = {
    backend: "webgl2",
    lod: "detail",
    cellSize: BASE_CELL_SIZE,
    borderCssPixels: 1,
    glyphs: true,
    detailMix: 1,
    backgroundColor: "",
    frameCount: 0,
    frameMs: 0,
    visibleCells: 0,
    drawnCells: 0,
    chunks: 0,
    storedCells: 0,
    cachedTiles: 0,
    drawCalls: 0,
    instanceUploads: 0,
    pixelRatio: 1,
    hoveredCells: 0,
    fps: null,
    redrawMode: "none",
    redrawnPixels: 0,
    blittedPixels: 0,
    canvasPixels: 1,
    fullRedraws: 0,
    damageRedraws: 0,
    panRedraws: 0,
  };

  private resources: GlResources;
  private theme: RenderTheme;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private frameId: number | null = null;
  private contextLost = false;
  private instanceCount = 0;
  private instanceUploads = 0;
  private frameCount = 0;
  private previousFrameStartedAt = 0;
  private smoothedFrameInterval = 0;
  private frameObserver: ((diagnostics: Readonly<RenderDiagnostics>) => void) | null = null;
  private cachedGeneration = -1;
  private range: TileRange | null = null;
  private pixelTextureOriginX = 0;
  private pixelTextureOriginY = 0;
  private pixelTextureWidth = 1;
  private pixelTextureHeight = 1;
  private readonly tileCache = new Map<string, CachedTile>();
  private hoverCells: Array<{ x: number; y: number }> = [];
  private hoverKey = "";
  private pendingFullRedraw = false;
  private pendingDamage: ExploredBounds | null = null;
  private retainedFrame = false;
  private retainedPanX = 0;
  private retainedPanY = 0;
  private retainedZoom = 1;
  private retainedGeneration = -1;
  private retainedVersion = -1;
  private scratchWidth = 0;
  private scratchHeight = 0;
  private fullRedraws = 0;
  private damageRedraws = 0;
  private panRedraws = 0;

  constructor(canvas: HTMLCanvasElement, model: GameModel) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL 2 is required to render Infinite Mines");
    this.canvas = canvas;
    this.gl = gl;
    this.model = model;
    this.theme = this.readTheme();
    this.resources = this.createResources();

    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.retainedFrame = false;
      if (this.frameId !== null) cancelAnimationFrame(this.frameId);
      this.frameId = null;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      this.resources = this.createResources();
      this.scratchWidth = 0;
      this.scratchHeight = 0;
      this.updateBackingStore(this.dpr);
      this.resetTileCache();
      this.retainedFrame = false;
      this.requestRender();
    });
  }

  get cellSize(): number {
    return BASE_CELL_SIZE * this.zoom;
  }

  setFrameObserver(observer: ((diagnostics: Readonly<RenderDiagnostics>) => void) | null): void {
    this.frameObserver = observer;
  }

  createViewSnapshot(): ViewSnapshotV1 {
    return { version: 1, panX: this.panX, panY: this.panY, zoom: this.zoom };
  }

  restoreView(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Partial<ViewSnapshotV1>;
    if (
      snapshot.version !== 1 ||
      !Number.isFinite(snapshot.panX) ||
      !Number.isFinite(snapshot.panY) ||
      !Number.isFinite(snapshot.zoom) ||
      (snapshot.zoom as number) < MIN_ZOOM ||
      (snapshot.zoom as number) > 2.2
    ) {
      return false;
    }
    this.panX = snapshot.panX as number;
    this.panY = snapshot.panY as number;
    this.zoom = snapshot.zoom as number;
    this.range = null;
    this.requestRender();
    return true;
  }

  refreshTheme(): void {
    this.theme = this.readTheme();
    if (this.contextLost) return;
    const gl = this.gl;
    const atlas = this.createAtlas();
    gl.bindTexture(gl.TEXTURE_2D, this.resources.atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    this.applyTheme(this.resources, atlas);
    this.requestRender();
  }

  resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(bounds.width));
    const nextHeight = Math.max(1, Math.round(bounds.height));
    if (nextWidth !== this.width || nextHeight !== this.height) {
      this.width = nextWidth;
      this.height = nextHeight;
      this.range = null;
    }
    this.updateBackingStore(Math.min(window.devicePixelRatio || 1, 2));
    this.requestRender();
  }

  home(): void {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.range = null;
    this.requestRender();
  }

  panBy(deltaX: number, deltaY: number): void {
    this.panX += deltaX;
    this.panY += deltaY;
    this.requestPan();
  }

  finishPan(): void {
    // Panning has no temporary render state, so release must remain redraw-free.
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const previousSize = this.cellSize;
    const worldX = (screenX - this.width / 2 - this.panX) / previousSize + 0.5;
    const worldY = (screenY - this.height / 2 - this.panY) / previousSize + 0.5;
    const nextZoom = Math.max(MIN_ZOOM, Math.min(2.2, this.zoom * factor));
    if (nextZoom === this.zoom) return;
    this.zoom = nextZoom;
    const nextSize = this.cellSize;
    this.panX = screenX - this.width / 2 - (worldX - 0.5) * nextSize;
    this.panY = screenY - this.height / 2 - (worldY - 0.5) * nextSize;
    this.requestRender();
  }

  screenToCell(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: Math.floor((screenX - this.width / 2 - this.panX) / this.cellSize + 0.5),
      y: Math.floor((screenY - this.height / 2 - this.panY) / this.cellSize + 0.5),
    };
  }

  setHoverCells(cells: ReadonlyArray<{ x: number; y: number }>): void {
    const unique = new Map<string, { x: number; y: number }>();
    for (const cell of cells) {
      if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y)) continue;
      unique.set(`${cell.x},${cell.y}`, { x: cell.x, y: cell.y });
    }
    const next = [...unique.values()].slice(0, 9);
    const key = next.map(({ x, y }) => `${x},${y}`).join(";");
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.hoverCells = next;
    this.diagnostics.hoveredCells = next.length;
  }

  get hoverPreview(): Array<{ x: number; y: number }> {
    return this.hoverCells.map((cell) => ({ ...cell }));
  }

  requestRender(damage?: ExploredBounds): void {
    if (damage) {
      if (!this.pendingFullRedraw) this.pendingDamage = this.unionBounds(this.pendingDamage, damage);
    } else {
      this.pendingFullRedraw = true;
      this.pendingDamage = null;
    }
    this.scheduleRender();
  }

  private requestPan(): void {
    if (!this.pendingFullRedraw) {
      if (this.pendingDamage) {
        this.pendingFullRedraw = true;
        this.pendingDamage = null;
      }
    }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.contextLost || this.frameId !== null) return;
    this.frameId = requestAnimationFrame(() => {
      this.frameId = null;
      const request: FrameRequest = this.pendingFullRedraw
        ? { kind: "full" }
        : this.pendingDamage
          ? { kind: "damage", damage: this.pendingDamage }
          : { kind: "pan" };
      this.pendingFullRedraw = false;
      this.pendingDamage = null;
      this.render(request);
    });
  }

  render(request: FrameRequest = { kind: "full" }): void {
    if (this.contextLost) return;
    const startedAt = performance.now();
    const cellSize = this.cellSize;
    if (this.cachedGeneration !== this.model.store.generation) {
      this.resetTileCache();
      this.cachedGeneration = this.model.store.generation;
      if (request.kind !== "full") this.retainedFrame = false;
    }

    const centerWorldX = 0.5 - this.panX / cellSize;
    const centerWorldY = 0.5 - this.panY / cellSize;
    const detailMix = this.detailMix(cellSize);
    const pixelLod = cellSize <= SPARSE_LOD_THRESHOLD;
    let anchorX: number;
    let anchorY: number;
    let minX: number;
    let minY: number;
    let maxX: number;
    let maxY: number;
    let requiredMinX: number;
    let requiredMinY: number;
    let requiredMaxX: number;
    let requiredMaxY: number;
    if (pixelLod) {
      const anchorWorldX =
        floorDiv(Math.floor(centerWorldX) + SPARSE_ANCHOR_CELLS / 2, SPARSE_ANCHOR_CELLS) * SPARSE_ANCHOR_CELLS;
      const anchorWorldY =
        floorDiv(Math.floor(centerWorldY) + SPARSE_ANCHOR_CELLS / 2, SPARSE_ANCHOR_CELLS) * SPARSE_ANCHOR_CELLS;
      anchorX = anchorWorldX / RENDER_TILE_CELLS;
      anchorY = anchorWorldY / RENDER_TILE_CELLS;
      const visibleMin = this.screenToCell(0, 0);
      const visibleMax = this.screenToCell(this.width, this.height);
      requiredMinX = floorDiv(visibleMin.x, RENDER_TILE_CELLS);
      requiredMinY = floorDiv(visibleMin.y, RENDER_TILE_CELLS);
      requiredMaxX = floorDiv(visibleMax.x, RENDER_TILE_CELLS);
      requiredMaxY = floorDiv(visibleMax.y, RENDER_TILE_CELLS);
      const overscanTiles = Math.ceil(PIXEL_LOD_OVERSCAN_CSS / cellSize / RENDER_TILE_CELLS);
      minX = requiredMinX - overscanTiles;
      minY = requiredMinY - overscanTiles;
      maxX = requiredMaxX + overscanTiles;
      maxY = requiredMaxY + overscanTiles;
    } else {
      anchorX = floorDiv(Math.floor(centerWorldX), RENDER_TILE_CELLS);
      anchorY = floorDiv(Math.floor(centerWorldY), RENDER_TILE_CELLS);
      const tilePixels = cellSize * RENDER_TILE_CELLS;
      const min = this.screenToCell(-tilePixels, -tilePixels);
      const max = this.screenToCell(this.width + tilePixels, this.height + tilePixels);
      minX = floorDiv(min.x, RENDER_TILE_CELLS);
      minY = floorDiv(min.y, RENDER_TILE_CELLS);
      maxX = floorDiv(max.x, RENDER_TILE_CELLS);
      maxY = floorDiv(max.y, RENDER_TILE_CELLS);
      requiredMinX = minX;
      requiredMinY = minY;
      requiredMaxX = maxX;
      requiredMaxY = maxY;
    }

    const lod = pixelLod ? "pixel" : "detail";
    if (this.rangeChanged(lod, anchorX, anchorY, requiredMinX, requiredMinY, requiredMaxX, requiredMaxY)) {
      if (pixelLod) this.rebuildPixelTexture(anchorX, anchorY, minX, minY, maxX, maxY);
      else this.rebuildInstances(anchorX, anchorY, minX, minY, maxX, maxY);
    }

    const relativeCameraX = centerWorldX - anchorX * RENDER_TILE_CELLS;
    const relativeCameraY = centerWorldY - anchorY * RENDER_TILE_CELLS;
    const canvasPixels = this.canvas.width * this.canvas.height;
    let redrawMode: RenderDiagnostics["redrawMode"] = request.kind;
    let redrawnPixels = canvasPixels;
    let blittedPixels = 0;
    let drawRects: PixelRect[] = [{ x: 0, y: 0, width: this.canvas.width, height: this.canvas.height }];

    if (request.kind === "damage" && request.damage && this.canReuseRetained(false)) {
      const rect = this.damageRect(request.damage, cellSize);
      if (!rect) {
        redrawMode = "none";
        redrawnPixels = 0;
        drawRects = [];
      } else if (rect.width * rect.height <= canvasPixels * MAX_DAMAGE_AREA_RATIO) {
        drawRects = [rect];
        redrawnPixels = rect.width * rect.height;
      } else {
        redrawMode = "full";
      }
    } else if (
      request.kind === "pan" &&
      !pixelLod &&
      this.dpr === 1 &&
      this.instanceCount >= PAN_BLIT_MIN_DETAIL_INSTANCES &&
      this.canReuseRetained(true)
    ) {
      const shiftXFloat = (this.panX - this.retainedPanX) * this.dpr;
      const shiftYFloat = -(this.panY - this.retainedPanY) * this.dpr;
      const shiftX = Math.round(shiftXFloat);
      const shiftY = Math.round(shiftYFloat);
      if (Math.abs(shiftXFloat - shiftX) > 1e-6 || Math.abs(shiftYFloat - shiftY) > 1e-6) {
        redrawMode = "full";
      } else if (shiftX === 0 && shiftY === 0) {
        redrawMode = "none";
        redrawnPixels = 0;
        drawRects = [];
      } else if (Math.abs(shiftX) >= this.canvas.width || Math.abs(shiftY) >= this.canvas.height) {
        redrawMode = "full";
      } else {
        blittedPixels = this.blitRetainedFrame(shiftX, shiftY);
        drawRects = this.exposedPanRects(shiftX, shiftY);
        redrawnPixels = drawRects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
      }
    } else if (request.kind !== "full") {
      redrawMode = "full";
    }

    if (redrawMode === "none") {
      this.captureRetainedState();
      this.diagnostics = {
        ...this.diagnostics,
        redrawMode,
        redrawnPixels,
        blittedPixels,
        canvasPixels,
        instanceUploads: this.instanceUploads,
        cachedTiles: this.tileCache.size,
        storedCells: this.model.store.nonZeroCells,
      };
      return;
    }

    const frameInterval = this.previousFrameStartedAt === 0 ? 0 : startedAt - this.previousFrameStartedAt;
    this.previousFrameStartedAt = startedAt;
    if (frameInterval > 0 && frameInterval < 250) {
      this.smoothedFrameInterval =
        this.smoothedFrameInterval === 0
          ? frameInterval
          : this.smoothedFrameInterval * 0.8 + frameInterval * 0.2;
    } else {
      this.smoothedFrameInterval = 0;
    }
    const drawCalls = this.drawScene(pixelLod, relativeCameraX, relativeCameraY, cellSize, drawRects);
    if (redrawMode === "full") this.fullRedraws += 1;
    else if (redrawMode === "damage") this.damageRedraws += 1;
    else this.panRedraws += 1;
    this.captureRetainedState();

    const visibleMin = this.screenToCell(0, 0);
    const visibleMax = this.screenToCell(this.width, this.height);
    this.frameCount += 1;
    this.diagnostics = {
      backend: "webgl2",
      lod,
      cellSize,
      borderCssPixels: cellSize >= 3 ? 1 : 0,
      glyphs: detailMix > 0,
      detailMix,
      backgroundColor: this.theme.background,
      frameCount: this.frameCount,
      frameMs: performance.now() - startedAt,
      visibleCells: (visibleMax.x - visibleMin.x + 1) * (visibleMax.y - visibleMin.y + 1),
      drawnCells: this.instanceCount,
      chunks: this.model.store.chunkCount,
      storedCells: this.model.store.nonZeroCells,
      cachedTiles: this.tileCache.size,
      drawCalls,
      instanceUploads: this.instanceUploads,
      pixelRatio: this.dpr,
      hoveredCells: this.hoverCells.length,
      fps: this.smoothedFrameInterval > 0 ? Math.min(999, Math.round(1000 / this.smoothedFrameInterval)) : null,
      redrawMode,
      redrawnPixels,
      blittedPixels,
      canvasPixels,
      fullRedraws: this.fullRedraws,
      damageRedraws: this.damageRedraws,
      panRedraws: this.panRedraws,
    };
    this.frameObserver?.(this.diagnostics);
  }

  private drawScene(
    pixelLod: boolean,
    relativeCameraX: number,
    relativeCameraY: number,
    cellSize: number,
    rects: ReadonlyArray<PixelRect>,
  ): number {
    const gl = this.gl;
    const resources = this.resources;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(...this.theme.backgroundRgb, 1);
    if (pixelLod) {
      gl.useProgram(resources.pixelProgram);
      gl.bindVertexArray(resources.pixelVertexArray);
      gl.uniform2f(resources.pixelViewportUniform, this.width, this.height);
      gl.uniform2f(resources.pixelCameraCellUniform, relativeCameraX, relativeCameraY);
      gl.uniform2i(resources.pixelTextureOriginUniform, this.pixelTextureOriginX, this.pixelTextureOriginY);
      gl.uniform2i(resources.pixelTextureSizeUniform, this.pixelTextureWidth, this.pixelTextureHeight);
      gl.uniform1f(resources.pixelCellSizeUniform, cellSize);
      gl.uniform1f(resources.pixelDprUniform, this.dpr);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, resources.stateTexture);
    } else {
      gl.useProgram(resources.program);
      gl.bindVertexArray(resources.vertexArray);
      gl.uniform2f(resources.viewportUniform, this.width, this.height);
      gl.uniform2f(resources.cameraCellUniform, relativeCameraX, relativeCameraY);
      gl.uniform1f(resources.cellSizeUniform, cellSize);
      gl.uniform1f(resources.dprUniform, this.dpr);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, resources.atlasTexture);
    }

    const fullFrame =
      rects.length === 1 &&
      rects[0].x === 0 &&
      rects[0].y === 0 &&
      rects[0].width === this.canvas.width &&
      rects[0].height === this.canvas.height;
    if (fullFrame) gl.disable(gl.SCISSOR_TEST);
    else gl.enable(gl.SCISSOR_TEST);
    let drawCalls = 0;
    for (const rect of rects) {
      if (!fullFrame) gl.scissor(rect.x, rect.y, rect.width, rect.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (this.instanceCount === 0) continue;
      if (pixelLod) gl.drawArrays(gl.TRIANGLES, 0, 6);
      else gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
      drawCalls += 1;
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
    return drawCalls;
  }

  private damageRect(bounds: ExploredBounds, cellSize: number): PixelRect | null {
    const leftCss = this.width / 2 + this.panX + (bounds.minX - 1.5) * cellSize;
    const rightCss = this.width / 2 + this.panX + (bounds.maxX + 1.5) * cellSize;
    const topCss = this.height / 2 + this.panY + (bounds.minY - 1.5) * cellSize;
    const bottomCss = this.height / 2 + this.panY + (bounds.maxY + 1.5) * cellSize;
    const left = Math.max(0, Math.floor(leftCss * this.dpr) - 1);
    const right = Math.min(this.canvas.width, Math.ceil(rightCss * this.dpr) + 1);
    const top = Math.max(0, Math.floor(topCss * this.dpr) - 1);
    const bottom = Math.min(this.canvas.height, Math.ceil(bottomCss * this.dpr) + 1);
    if (left >= right || top >= bottom) return null;
    return { x: left, y: this.canvas.height - bottom, width: right - left, height: bottom - top };
  }

  private exposedPanRects(shiftX: number, shiftY: number): PixelRect[] {
    const rects: PixelRect[] = [];
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (shiftX > 0) rects.push({ x: 0, y: 0, width: shiftX, height });
    else if (shiftX < 0) rects.push({ x: width + shiftX, y: 0, width: -shiftX, height });

    const overlapX = shiftX > 0 ? shiftX : 0;
    const overlapWidth = width - Math.abs(shiftX);
    if (shiftY > 0) rects.push({ x: overlapX, y: 0, width: overlapWidth, height: shiftY });
    else if (shiftY < 0) rects.push({ x: overlapX, y: height + shiftY, width: overlapWidth, height: -shiftY });
    return rects.filter((rect) => rect.width > 0 && rect.height > 0);
  }

  private blitRetainedFrame(shiftX: number, shiftY: number): number {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const sourceX0 = Math.max(0, -shiftX);
    const sourceY0 = Math.max(0, -shiftY);
    const sourceX1 = Math.min(width, width - shiftX);
    const sourceY1 = Math.min(height, height - shiftY);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resources.scratchFramebuffer);
    gl.blitFramebuffer(
      sourceX0,
      sourceY0,
      sourceX1,
      sourceY1,
      sourceX0,
      sourceY0,
      sourceX1,
      sourceY1,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.resources.scratchFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(
      sourceX0,
      sourceY0,
      sourceX1,
      sourceY1,
      sourceX0 + shiftX,
      sourceY0 + shiftY,
      sourceX1 + shiftX,
      sourceY1 + shiftY,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return (sourceX1 - sourceX0) * (sourceY1 - sourceY0);
  }

  private canReuseRetained(requireCurrentVersion: boolean): boolean {
    return (
      this.retainedFrame &&
      this.retainedZoom === this.zoom &&
      this.retainedGeneration === this.model.store.generation &&
      (!requireCurrentVersion || this.retainedVersion === this.model.store.version) &&
      (requireCurrentVersion || (this.retainedPanX === this.panX && this.retainedPanY === this.panY))
    );
  }

  private captureRetainedState(): void {
    this.retainedFrame = true;
    this.retainedPanX = this.panX;
    this.retainedPanY = this.panY;
    this.retainedZoom = this.zoom;
    this.retainedGeneration = this.model.store.generation;
    this.retainedVersion = this.model.store.version;
  }

  private unionBounds(left: ExploredBounds | null, right: ExploredBounds): ExploredBounds {
    if (!left) return { ...right };
    return {
      minX: Math.min(left.minX, right.minX),
      minY: Math.min(left.minY, right.minY),
      maxX: Math.max(left.maxX, right.maxX),
      maxY: Math.max(left.maxY, right.maxY),
    };
  }

  drawOverview(canvas: HTMLCanvasElement): string {
    const context = canvas.getContext("2d");
    if (!context) return "Overview unavailable";
    const cssWidth = Math.max(280, Math.round(canvas.getBoundingClientRect().width));
    const cssHeight = Math.max(220, Math.round(canvas.getBoundingClientRect().height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = this.theme.overview;
    context.fillRect(0, 0, cssWidth, cssHeight);

    const bounds = this.model.bounds;
    if (!bounds) return "Nothing explored yet";
    const worldWidth = bounds.maxX - bounds.minX + 1;
    const worldHeight = bounds.maxY - bounds.minY + 1;
    const padding = 24;
    const scale = Math.min((cssWidth - padding * 2) / worldWidth, (cssHeight - padding * 2) / worldHeight, 22);
    const drawWidth = worldWidth * scale;
    const drawHeight = worldHeight * scale;
    const originX = (cssWidth - drawWidth) / 2 - bounds.minX * scale;
    const originY = (cssHeight - drawHeight) / 2 - bounds.minY * scale;
    const pixelSize = Math.max(1, scale + 0.15);

    this.model.store.forEachNonZero((x, y, state) => {
      if (isOpened(state)) context.fillStyle = this.model.artifactAt(x, y) ? this.theme.artifact : this.theme.overviewOpened;
      else if (state === CellState.Exploded) context.fillStyle = this.theme.exploded;
      else if (state === CellState.Flagged) context.fillStyle = this.theme.flag;
      else return;
      context.fillRect(originX + x * scale, originY + y * scale, pixelSize, pixelSize);
    });

    context.fillStyle = this.theme.background;
    context.strokeStyle = this.theme.ink;
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(originX + scale / 2, originY + scale / 2, Math.max(3, scale * 0.7), 0, Math.PI * 2);
    context.fill();
    context.stroke();

    return `${worldWidth.toLocaleString()} × ${worldHeight.toLocaleString()} cells · ${this.model.store.openedCells.toLocaleString()} revealed`;
  }

  private rangeChanged(
    lod: "detail" | "pixel",
    anchorX: number,
    anchorY: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): boolean {
    const range = this.range;
    return (
      !range ||
      range.lod !== lod ||
      range.anchorX !== anchorX ||
      range.anchorY !== anchorY ||
      range.minX > minX ||
      range.minY > minY ||
      range.maxX < maxX ||
      range.maxY < maxY ||
      range.generation !== this.model.store.generation ||
      range.version !== this.model.store.version
    );
  }

  private updateBackingStore(dpr: number): void {
    this.dpr = dpr;
    const pixelWidth = Math.round(this.width * dpr);
    const pixelHeight = Math.round(this.height * dpr);
    const resized = this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight;
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    if (resized || this.scratchWidth !== pixelWidth || this.scratchHeight !== pixelHeight) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.resources.scratchTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pixelWidth, pixelHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.scratchWidth = pixelWidth;
      this.scratchHeight = pixelHeight;
      this.retainedFrame = false;
    }
  }

  private detailMix(cellSize: number): number {
    const progress = Math.max(0, Math.min(1, (cellSize - DETAIL_FADE_START) / (DETAIL_FADE_END - DETAIL_FADE_START)));
    return progress * progress * (3 - 2 * progress);
  }

  private rebuildInstances(anchorX: number, anchorY: number, minX: number, minY: number, maxX: number, maxY: number): void {
    const tileCount = (maxX - minX + 1) * (maxY - minY + 1);
    const visibleTiles: VisibleTile[] = [];
    let instanceFloats = 0;
    for (let tileY = minY; tileY <= maxY; tileY += 1) {
      for (let tileX = minX; tileX <= maxX; tileX += 1) {
        const cells = this.getTileCells(tileX, tileY);
        if (cells.length === 0) continue;
        visibleTiles.push({
          relativeOriginX: (tileX - anchorX) * RENDER_TILE_CELLS,
          relativeOriginY: (tileY - anchorY) * RENDER_TILE_CELLS,
          worldOriginX: tileX * RENDER_TILE_CELLS,
          worldOriginY: tileY * RENDER_TILE_CELLS,
          cells,
        });
        instanceFloats += (cells.length / CACHED_CELL_FLOATS) * INSTANCE_FLOATS;
      }
    }

    const instances = new Float32Array(instanceFloats);
    let instanceIndex = 0;
    for (const tile of visibleTiles) {
      for (let source = 0; source < tile.cells.length; source += CACHED_CELL_FLOATS) {
        const localX = tile.cells[source];
        const localY = tile.cells[source + 1];
        const worldX = tile.worldOriginX + localX;
        const worldY = tile.worldOriginY + localY;
        let edges = 1 | 2;
        if (!this.isRenderable(this.model.getState(worldX + 1, worldY))) edges |= 4;
        if (!this.isRenderable(this.model.getState(worldX, worldY + 1))) edges |= 8;
        instances[instanceIndex++] = tile.relativeOriginX + localX;
        instances[instanceIndex++] = tile.relativeOriginY + localY;
        instances[instanceIndex++] = tile.cells[source + 2];
        instances[instanceIndex++] = tile.cells[source + 3];
        instances[instanceIndex++] = edges;
      }
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.resources.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances.subarray(0, instanceIndex), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.instanceUploads += 1;
    this.instanceCount = instanceIndex / INSTANCE_FLOATS;
    this.range = {
      lod: "detail",
      anchorX,
      anchorY,
      minX,
      minY,
      maxX,
      maxY,
      generation: this.model.store.generation,
      version: this.model.store.version,
    };
    this.trimTileCache(Math.max(MAX_CACHED_TILES, tileCount + 256));
  }

  private rebuildPixelTexture(
    anchorX: number,
    anchorY: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    const anchorWorldX = anchorX * RENDER_TILE_CELLS;
    const anchorWorldY = anchorY * RENDER_TILE_CELLS;
    const minWorldX = minX * RENDER_TILE_CELLS;
    const minWorldY = minY * RENDER_TILE_CELLS;
    const maxWorldX = (maxX + 1) * RENDER_TILE_CELLS - 1;
    const maxWorldY = (maxY + 1) * RENDER_TILE_CELLS - 1;
    let visibleStates = 0;
    let storedMinX = Number.POSITIVE_INFINITY;
    let storedMinY = Number.POSITIVE_INFINITY;
    let storedMaxX = Number.NEGATIVE_INFINITY;
    let storedMaxY = Number.NEGATIVE_INFINITY;
    this.model.store.forEachNonZeroInBounds(minWorldX, minWorldY, maxWorldX, maxWorldY, (x, y) => {
      storedMinX = Math.min(storedMinX, x);
      storedMinY = Math.min(storedMinY, y);
      storedMaxX = Math.max(storedMaxX, x);
      storedMaxY = Math.max(storedMaxY, y);
      visibleStates += 1;
    });
    const textureOriginX = visibleStates > 0 ? storedMinX : anchorWorldX;
    const textureOriginY = visibleStates > 0 ? storedMinY : anchorWorldY;
    const textureWidth = visibleStates > 0 ? storedMaxX - storedMinX + 1 : 1;
    const textureHeight = visibleStates > 0 ? storedMaxY - storedMinY + 1 : 1;
    const statePixels = new Uint8Array(textureWidth * textureHeight);
    this.model.store.forEachNonZeroInBounds(minWorldX, minWorldY, maxWorldX, maxWorldY, (x, y, state) => {
      const sprite = this.spriteFor(state);
      const artifact = isOpened(state) && this.model.artifactAt(x, y) ? 16 : 0;
      statePixels[(y - textureOriginY) * textureWidth + x - textureOriginX] = sprite + 1 + artifact;
    });

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.resources.stateTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, textureWidth, textureHeight, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, statePixels);
    this.instanceUploads += 1;
    this.instanceCount = visibleStates;
    this.pixelTextureOriginX = textureOriginX - anchorWorldX;
    this.pixelTextureOriginY = textureOriginY - anchorWorldY;
    this.pixelTextureWidth = textureWidth;
    this.pixelTextureHeight = textureHeight;
    this.range = {
      lod: "pixel",
      anchorX,
      anchorY,
      minX,
      minY,
      maxX,
      maxY,
      generation: this.model.store.generation,
      version: this.model.store.version,
    };
    this.trimTileCache(MAX_CACHED_TILES);
  }

  private getTileCells(tileX: number, tileY: number): Float32Array {
    const key = `${tileX},${tileY}`;
    const version = this.model.store.getTileVersion(tileX, tileY);
    const existing = this.tileCache.get(key);
    if (existing?.generation === this.model.store.generation && existing.version === version) {
      this.tileCache.delete(key);
      this.tileCache.set(key, existing);
      return existing.cells;
    }

    const cells = new Float32Array(CELLS_PER_TILE * CACHED_CELL_FLOATS);
    const originX = tileX * RENDER_TILE_CELLS;
    const originY = tileY * RENDER_TILE_CELLS;
    let index = 0;
    for (let localY = 0; localY < RENDER_TILE_CELLS; localY += 1) {
      for (let localX = 0; localX < RENDER_TILE_CELLS; localX += 1) {
        const state = this.model.getState(originX + localX, originY + localY);
        if (state === CellState.Covered || state === CellState.Queued) continue;
        cells[index++] = localX;
        cells[index++] = localY;
        cells[index++] = this.spriteFor(state);
        cells[index++] = isOpened(state) && this.model.artifactAt(originX + localX, originY + localY) ? 1 : 0;
      }
    }

    const tile: CachedTile = {
      cells: cells.slice(0, index),
      generation: this.model.store.generation,
      version,
    };
    this.tileCache.set(key, tile);
    return tile.cells;
  }

  private spriteFor(state: CellState): number {
    if (isOpened(state)) return state - CellState.Opened;
    if (state === CellState.Flagged) return 9;
    if (state === CellState.Question) return 10;
    return 11;
  }

  private isRenderable(state: CellState): boolean {
    return state !== CellState.Covered && state !== CellState.Queued;
  }

  private trimTileCache(maxTiles: number): void {
    while (this.tileCache.size > maxTiles) {
      const oldestKey = this.tileCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.tileCache.delete(oldestKey);
    }
  }

  private resetTileCache(): void {
    this.tileCache.clear();
    this.range = null;
    this.instanceCount = 0;
  }

  private createResources(): GlResources {
    const gl = this.gl;
    const program = requireProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    const pixelProgram = requireProgram(gl, PIXEL_VERTEX_SHADER, PIXEL_FRAGMENT_SHADER);
    const vertexArray = gl.createVertexArray();
    const pixelVertexArray = gl.createVertexArray();
    const quadBuffer = gl.createBuffer();
    const instanceBuffer = gl.createBuffer();
    const atlasTexture = gl.createTexture();
    const stateTexture = gl.createTexture();
    const scratchTexture = gl.createTexture();
    const scratchFramebuffer = gl.createFramebuffer();
    if (
      !vertexArray ||
      !pixelVertexArray ||
      !quadBuffer ||
      !instanceBuffer ||
      !atlasTexture ||
      !stateTexture ||
      !scratchTexture ||
      !scratchFramebuffer
    ) {
      throw new Error("Unable to allocate WebGL renderer resources");
    }

    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(
      2,
      1,
      gl.FLOAT,
      false,
      INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      CACHED_CELL_FLOATS * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    gl.bindVertexArray(pixelVertexArray);
    gl.bindVertexArray(null);

    const atlas = this.createAtlas();
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, scratchTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scratchFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scratchTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Unable to allocate retained framebuffer");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.bindTexture(gl.TEXTURE_2D, stateTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.useProgram(program);
    gl.uniform1i(requireUniform(gl, program, "u_atlas"), 0);
    gl.useProgram(pixelProgram);
    gl.uniform1i(requireUniform(gl, pixelProgram, "u_stateTexture"), 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    const resources = {
      program,
      pixelProgram,
      vertexArray,
      pixelVertexArray,
      instanceBuffer,
      atlasTexture,
      stateTexture,
      scratchTexture,
      scratchFramebuffer,
      viewportUniform: requireUniform(gl, program, "u_viewport"),
      cameraCellUniform: requireUniform(gl, program, "u_cameraCell"),
      cellSizeUniform: requireUniform(gl, program, "u_cellSize"),
      dprUniform: requireUniform(gl, program, "u_dpr"),
      artifactUniform: requireUniform(gl, program, "u_artifact"),
      artifactEdgeUniform: requireUniform(gl, program, "u_artifactEdge"),
      lodArtifactUniform: requireUniform(gl, program, "u_lodArtifact"),
      cellUniform: requireUniform(gl, program, "u_cell"),
      cellBorderUniform: requireUniform(gl, program, "u_cellBorder"),
      markedUniform: requireUniform(gl, program, "u_marked"),
      explodedUniform: requireUniform(gl, program, "u_exploded"),
      lodColorsUniform: requireUniform(gl, program, "u_lodColors[0]"),
      pixelViewportUniform: requireUniform(gl, pixelProgram, "u_viewport"),
      pixelCameraCellUniform: requireUniform(gl, pixelProgram, "u_cameraCell"),
      pixelTextureOriginUniform: requireUniform(gl, pixelProgram, "u_textureOrigin"),
      pixelTextureSizeUniform: requireUniform(gl, pixelProgram, "u_textureSize"),
      pixelCellSizeUniform: requireUniform(gl, pixelProgram, "u_cellSize"),
      pixelDprUniform: requireUniform(gl, pixelProgram, "u_dpr"),
      pixelLodArtifactUniform: requireUniform(gl, pixelProgram, "u_lodArtifact"),
      pixelLodColorsUniform: requireUniform(gl, pixelProgram, "u_lodColors[0]"),
    };
    this.applyTheme(resources, atlas);
    return resources;
  }

  private applyTheme(resources: GlResources, atlas: HTMLCanvasElement): void {
    const gl = this.gl;
    const lodColors = this.createLodColors(atlas);
    const cell = hexToRgb(this.theme.cell);
    const artifactArea = 0.44 * 0.44;
    const artifactEdgeArea = 0.54 * 0.54 - artifactArea;
    const artifactLod = cell.map(
      (channel, index) =>
        channel * (1 - artifactArea - artifactEdgeArea) +
        this.theme.artifactRgb[index] * artifactArea +
        this.theme.artifactEdgeRgb[index] * artifactEdgeArea,
    ) as [number, number, number];
    gl.useProgram(resources.program);
    gl.uniform3fv(resources.artifactUniform, this.theme.artifactRgb);
    gl.uniform3fv(resources.artifactEdgeUniform, this.theme.artifactEdgeRgb);
    gl.uniform3fv(resources.lodArtifactUniform, artifactLod);
    gl.uniform3fv(resources.cellUniform, cell);
    gl.uniform3fv(resources.cellBorderUniform, hexToRgb(this.theme.cellBorder));
    gl.uniform3fv(resources.markedUniform, hexToRgb(this.theme.marked));
    gl.uniform3fv(resources.explodedUniform, hexToRgb(this.theme.exploded));
    gl.uniform3fv(resources.lodColorsUniform, lodColors);
    gl.useProgram(resources.pixelProgram);
    gl.uniform3fv(resources.pixelLodArtifactUniform, artifactLod);
    gl.uniform3fv(resources.pixelLodColorsUniform, lodColors);
  }

  private createLodColors(atlas: HTMLCanvasElement): Float32Array {
    const context = atlas.getContext("2d");
    if (!context) throw new Error("Unable to sample sprite atlas");
    const pixels = context.getImageData(0, 0, atlas.width, atlas.height).data;
    const colors = new Float32Array(SPRITE_COUNT * 3);
    const cell = hexToRgb(this.theme.cell);
    const marked = hexToRgb(this.theme.marked);
    const exploded = hexToRgb(this.theme.exploded);
    const spriteArea = SPRITE_PIXELS * SPRITE_PIXELS;
    for (let sprite = 0; sprite < SPRITE_COUNT; sprite += 1) {
      const base = sprite === 11 ? exploded : sprite >= 9 ? marked : cell;
      const totals = [0, 0, 0];
      for (let y = 0; y < SPRITE_PIXELS; y += 1) {
        for (let x = 0; x < SPRITE_PIXELS; x += 1) {
          const pixel = (y * atlas.width + sprite * SPRITE_PIXELS + x) * 4;
          const alpha = pixels[pixel + 3] / 255;
          for (let channel = 0; channel < 3; channel += 1) {
            totals[channel] += base[channel] * (1 - alpha) + (pixels[pixel + channel] / 255) * alpha;
          }
        }
      }
      for (let channel = 0; channel < 3; channel += 1) colors[sprite * 3 + channel] = totals[channel] / spriteArea;
    }
    return colors;
  }

  private readTheme(): RenderTheme {
    const styles = getComputedStyle(document.documentElement);
    const color = (name: string): string => styles.getPropertyValue(name).trim();
    const background = color("--board-bg");
    const artifact = color("--board-artifact");
    const artifactEdge = color("--board-artifact-edge");
    return {
      background,
      backgroundRgb: hexToRgb(background),
      cell: color("--board-cell"),
      cellBorder: color("--board-cell-border"),
      marked: color("--board-marked"),
      ink: color("--ink"),
      flag: color("--board-flag"),
      flagStroke: color("--board-flag-stroke"),
      question: color("--board-question"),
      exploded: color("--board-exploded"),
      mine: color("--board-mine"),
      spark: color("--board-spark"),
      artifact,
      artifactEdge,
      artifactRgb: hexToRgb(artifact),
      artifactEdgeRgb: hexToRgb(artifactEdge),
      overview: color("--overview-bg"),
      overviewOpened: color("--overview-opened"),
      numbers: Array.from({ length: 9 }, (_, index) => color(`--board-number-${index}`)),
    };
  }

  private createAtlas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = SPRITE_PIXELS * SPRITE_COUNT;
    canvas.height = SPRITE_PIXELS;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create sprite atlas");
    for (let sprite = 0; sprite < SPRITE_COUNT; sprite += 1) {
      this.drawSprite(context, sprite * SPRITE_PIXELS, SPRITE_PIXELS, sprite);
    }
    return canvas;
  }

  private drawSprite(context: CanvasRenderingContext2D, left: number, size: number, sprite: number): void {
    const theme = this.theme;
    context.clearRect(left, 0, size, size);

    if (sprite >= 1 && sprite <= 8) {
      context.fillStyle = theme.numbers[sprite];
      context.font = `800 ${Math.round(size * 0.62)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(sprite), left + size / 2, size * 0.53);
    } else if (sprite === 9) {
      context.strokeStyle = theme.flagStroke;
      context.fillStyle = theme.flag;
      context.lineWidth = Math.max(1.3, size / 14);
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(left + size * 0.38, size * 0.22);
      context.lineTo(left + size * 0.38, size * 0.76);
      context.stroke();
      context.beginPath();
      context.moveTo(left + size * 0.4, size * 0.24);
      context.lineTo(left + size * 0.75, size * 0.38);
      context.lineTo(left + size * 0.4, size * 0.5);
      context.closePath();
      context.fill();
      context.stroke();
    } else if (sprite === 10) {
      context.fillStyle = theme.question;
      context.font = `800 ${Math.round(size * 0.7)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("?", left + size / 2, size * 0.52);
    } else if (sprite === 11) {
      const centerX = left + size / 2;
      const centerY = size / 2;
      context.fillStyle = theme.mine;
      context.beginPath();
      for (let point = 0; point < 16; point += 1) {
        const angle = (point / 16) * Math.PI * 2;
        const radius = point % 2 === 0 ? size * 0.38 : size * 0.22;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;
        if (point === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.fill();
      context.fillStyle = theme.spark;
      context.beginPath();
      context.arc(centerX, centerY, size * 0.12, 0, Math.PI * 2);
      context.fill();
    }
  }
}
