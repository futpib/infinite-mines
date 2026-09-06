import { CellState, GameModel, STATE_TILE_SIZE, floorDiv, isOpened, openedClue, type ExploredBounds } from "./model";
import type { ViewSnapshotV1 } from "./persistence";
import {
  compareCells,
  type TopologyId,
  type WorldBounds,
  type WorldPoint,
} from "./topology";

export interface RenderDiagnostics {
  backend: "webgl2";
  topology: TopologyId;
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
  frontierCells: number;
  frontierEdges: number;
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
const GENERIC_INSTANCE_FLOATS = 10;
const SQUARE_MAX_CLUE_SPRITE = 8;
const SQUARE_FLAG_SPRITE = 9;
const SQUARE_QUESTION_SPRITE = 10;
const SQUARE_EXPLODED_SPRITE = 11;
const SQUARE_SPRITE_COUNT = 12;
const ARTIFACT_CELL_KIND = 1;
const FRONTIER_CELL_KIND = 2;
const MAX_CLUE_SPRITE = 18;
const FLAG_SPRITE = 19;
const QUESTION_SPRITE = 20;
const EXPLODED_SPRITE = 21;
const SPRITE_COUNT = 22;
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
flat out float v_cellKind;
flat out float v_edges;

void main() {
  vec2 start = u_viewport * 0.5 + (a_cell.xy - u_cameraCell) * u_cellSize;
  vec2 end = u_viewport * 0.5 + (a_cell.xy - u_cameraCell + 1.0) * u_cellSize;
  vec2 startDevice = floor(start * u_dpr + 0.5);
  vec2 endDevice = floor(end * u_dpr + 0.5);
  int edges = int(a_edges + 0.5);
  vec2 extensionDevice = vec2(
    (edges & 4) != 0 ? u_dpr : 0.0,
    (edges & 8) != 0 ? u_dpr : 0.0
  );
  vec2 drawPixelDevice = mix(startDevice, endDevice + extensionDevice, a_corner);
  vec2 pixel = drawPixelDevice / u_dpr;
  vec2 clip = pixel / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_cellUv = (drawPixelDevice - startDevice) / max(endDevice - startDevice, vec2(1.0));
  v_sprite = a_cell.z;
  v_cellKind = a_cell.w;
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
uniform vec3 u_background;
uniform vec3 u_marked;
uniform vec3 u_exploded;
uniform vec3 u_lodColors[${SQUARE_SPRITE_COUNT}];
uniform float u_dpr;
uniform float u_cellSize;

in vec2 v_cellUv;
flat in float v_sprite;
flat in float v_cellKind;
flat in float v_edges;
out vec4 outColor;

void main() {
  int edges = int(v_edges + 0.5);
  bool frontier = v_cellKind > 1.5;
  bool artifact = v_cellKind > 0.5 && !frontier;
  bool insideCell = v_cellUv.x >= 0.0 && v_cellUv.y >= 0.0 && v_cellUv.x < 1.0 && v_cellUv.y < 1.0;
  bool outerBorder = ((edges & 4) != 0 && v_cellUv.x >= 1.0) || ((edges & 8) != 0 && v_cellUv.y >= 1.0);
  vec3 fill = frontier ? u_background : (v_sprite == ${SQUARE_EXPLODED_SPRITE.toFixed(1)} ? u_exploded : (v_sprite >= ${SQUARE_FLAG_SPRITE.toFixed(1)} ? u_marked : u_cell));
  vec3 base = fill;
  if (u_cellSize >= 3.0) {
    vec2 pixelWidth = max(fwidth(v_cellUv), vec2(0.000001));
    vec2 edgeDistance = vec2(
      v_cellUv.y / pixelWidth.y,
      v_cellUv.x / pixelWidth.x
    );
    float innerDistance = 100000.0;
    if ((edges & 1) != 0) innerDistance = min(innerDistance, edgeDistance.x);
    if ((edges & 2) != 0) innerDistance = min(innerDistance, edgeDistance.y);
    float fillMix = smoothstep(u_dpr - 0.5, u_dpr + 0.5, innerDistance);
    base = mix(u_cellBorder, fill, fillMix);
  }

  int stateIndex = int(clamp(v_sprite, 0.0, ${SQUARE_EXPLODED_SPRITE.toFixed(1)}) + 0.5);
  vec3 stateColor = frontier ? u_background : (artifact ? u_lodArtifact : u_lodColors[stateIndex]);

  vec2 atlasPixel = vec2(v_sprite * float(${SPRITE_PIXELS}), 0.0) + clamp(v_cellUv, 0.0, 1.0) * float(${SPRITE_PIXELS - 1}) + 0.5;
  vec2 atlasSize = vec2(float(${SQUARE_SPRITE_COUNT * SPRITE_PIXELS}), float(${SPRITE_PIXELS}));
  vec4 glyph = texture(u_atlas, atlasPixel / atlasSize);
  if (!insideCell || frontier) glyph.a = 0.0;
  vec4 color = vec4(mix(base, glyph.rgb, glyph.a), 1.0);

  if (artifact && insideCell) {
    vec2 centered = v_cellUv - 0.5;
    vec2 rotated = vec2(centered.x + centered.y, centered.y - centered.x) * 0.707107;
    float square = max(abs(rotated.x), abs(rotated.y));
    if (square < 0.27) color = vec4(u_artifactEdge, 1.0);
    if (square < 0.22) color = vec4(u_artifact, 1.0);
  }

  float detailMix = smoothstep(${DETAIL_FADE_START.toFixed(1)}, ${DETAIL_FADE_END.toFixed(1)}, u_cellSize);
  if (outerBorder) {
    outColor = vec4(mix(u_background, u_cellBorder, detailMix), 1.0);
    return;
  }
  outColor = vec4(mix(stateColor, color.rgb, detailMix), 1.0);
}`;

const GENERIC_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_centerAxisU;
layout(location = 2) in vec4 a_axisVState;
layout(location = 3) in vec2 a_shapeEdges;

uniform vec2 u_viewport;
uniform vec2 u_cameraWorld;
uniform float u_cellSize;

out vec2 v_local;
out vec2 v_spriteOffset;
flat out float v_sprite;
flat out float v_cellKind;
flat out float v_shape;
flat out float v_edges;

void main() {
  int shape = int(a_shapeEdges.x + 0.5);
  vec2 local = a_corner * 2.0 - 1.0;
  if (shape == 3) {
    // A rhombus vertex sits on the edge of this instanced bounding quad. Grow
    // only the carrier quad so the fragment shader, which still clips to the
    // exact diamond, can own every shared-vertex device pixel.
    vec2 carrierMargin = vec2(
      2.0 / max(u_cellSize * length(a_centerAxisU.zw), 1.0),
      2.0 / max(u_cellSize * length(a_axisVState.xy), 1.0)
    );
    local *= 1.0 + carrierMargin;
  }
  vec2 world = a_centerAxisU.xy + local.x * a_centerAxisU.zw + local.y * a_axisVState.xy;
  vec2 spriteCenter = a_centerAxisU.xy;
  if (shape == 1) spriteCenter += a_axisVState.xy / 3.0;
  if (shape == 2) spriteCenter -= a_axisVState.xy / 3.0;
  vec2 pixel = u_viewport * 0.5 + (world - u_cameraWorld) * u_cellSize;
  vec2 clip = pixel / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_local = local;
  v_spriteOffset = world - spriteCenter;
  v_sprite = a_axisVState.z;
  v_cellKind = a_axisVState.w;
  v_shape = a_shapeEdges.x;
  v_edges = a_shapeEdges.y;
}`;

const GENERIC_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform vec3 u_artifact;
uniform vec3 u_artifactEdge;
uniform vec3 u_lodArtifact;
uniform vec3 u_cell;
uniform vec3 u_cellBorder;
uniform vec3 u_background;
uniform vec3 u_marked;
uniform vec3 u_exploded;
uniform vec3 u_lodColors[${SPRITE_COUNT}];
uniform float u_dpr;
uniform float u_cellSize;

in vec2 v_local;
in vec2 v_spriteOffset;
flat in float v_sprite;
flat in float v_cellKind;
flat in float v_shape;
flat in float v_edges;
out vec4 outColor;

void includeEdge(float lineValue, int bit, int edges, inout float edgePixels) {
  if ((edges & bit) != 0) edgePixels = min(edgePixels, lineValue / max(fwidth(lineValue), 0.000001));
}

void main() {
  int shape = int(v_shape + 0.5);
  int edges = int(v_edges + 0.5);
  bool frontier = v_cellKind > 1.5;
  bool artifact = v_cellKind > 0.5 && !frontier;
  float edgePixels = 100000.0;
  bool inside = false;
  if (shape == 1) {
    float left = v_local.x + (v_local.y + 1.0) * 0.5;
    float right = (v_local.y + 1.0) * 0.5 - v_local.x;
    float base = 1.0 - v_local.y;
    inside = left >= 0.0 && right >= 0.0 && base >= 0.0;
    includeEdge(left, 1, edges, edgePixels);
    includeEdge(right, 2, edges, edgePixels);
    includeEdge(base, 4, edges, edgePixels);
  } else if (shape == 2) {
    float base = v_local.y + 1.0;
    float right = (1.0 - v_local.y) * 0.5 - v_local.x;
    float left = v_local.x + (1.0 - v_local.y) * 0.5;
    inside = base >= 0.0 && right >= 0.0 && left >= 0.0;
    includeEdge(base, 1, edges, edgePixels);
    includeEdge(right, 2, edges, edgePixels);
    includeEdge(left, 4, edges, edgePixels);
  } else {
    float edge0 = 1.0 + v_local.x + v_local.y;
    float edge1 = 1.0 - v_local.x + v_local.y;
    float edge2 = 1.0 - v_local.x - v_local.y;
    float edge3 = 1.0 + v_local.x - v_local.y;
    float ownershipTolerance = max(max(fwidth(edge0), fwidth(edge1)), max(fwidth(edge2), fwidth(edge3))) * 0.75;
    bool withinCoverage = min(min(edge0, edge1), min(edge2, edge3)) >= -ownershipTolerance;
    // Draw the same centered border from both incident rhombi. Their expanded
    // carrier quads overlap only in this narrow strip, so draw order cannot
    // reveal the clear color at diagonal edges or six-way vertices.
    inside = withinCoverage;
    if (frontier) {
      if ((edges & 1) != 0) edgePixels = min(edgePixels, abs(edge0) / max(fwidth(edge0), 0.000001) * 2.0);
      if ((edges & 2) != 0) edgePixels = min(edgePixels, abs(edge1) / max(fwidth(edge1), 0.000001) * 2.0);
      if ((edges & 4) != 0) edgePixels = min(edgePixels, abs(edge2) / max(fwidth(edge2), 0.000001) * 2.0);
      if ((edges & 8) != 0) edgePixels = min(edgePixels, abs(edge3) / max(fwidth(edge3), 0.000001) * 2.0);
    } else {
      edgePixels = min(
        min(abs(edge0) / max(fwidth(edge0), 0.000001), abs(edge1) / max(fwidth(edge1), 0.000001)),
        min(abs(edge2) / max(fwidth(edge2), 0.000001), abs(edge3) / max(fwidth(edge3), 0.000001))
      ) * 2.0;
    }
  }
  if (!inside) discard;

  vec3 fill = frontier ? u_background : (v_sprite == ${EXPLODED_SPRITE.toFixed(1)} ? u_exploded : (v_sprite >= ${FLAG_SPRITE.toFixed(1)} ? u_marked : u_cell));
  vec3 detailedBase = fill;
  if (u_cellSize >= 3.0 && edgePixels < 100000.0) {
    float fillMix = smoothstep(u_dpr - 0.5, u_dpr + 0.5, edgePixels);
    detailedBase = mix(u_cellBorder, fill, fillMix);
  }

  int stateIndex = int(clamp(v_sprite, 0.0, ${EXPLODED_SPRITE.toFixed(1)}) + 0.5);
  vec3 stateColor = frontier ? u_background : (artifact ? u_lodArtifact : u_lodColors[stateIndex]);
  float contentExtent = shape == 3 ? 0.85 : 0.62;
  vec2 contentLocal = v_spriteOffset / contentExtent;
  vec2 uv = clamp(contentLocal + 0.5, 0.0, 1.0);
  vec2 atlasPixel = vec2(v_sprite * float(${SPRITE_PIXELS}), 0.0) + uv * float(${SPRITE_PIXELS - 1}) + 0.5;
  vec2 atlasSize = vec2(float(${SPRITE_COUNT * SPRITE_PIXELS}), float(${SPRITE_PIXELS}));
  vec4 glyph = texture(u_atlas, atlasPixel / atlasSize);
  if (frontier) glyph.a = 0.0;
  vec3 detailed = mix(detailedBase, glyph.rgb, glyph.a);

  if (artifact) {
    vec2 rotated = vec2(contentLocal.x + contentLocal.y, contentLocal.y - contentLocal.x) * 0.707107;
    float square = max(abs(rotated.x), abs(rotated.y));
    if (square < 0.27) detailed = u_artifactEdge;
    if (square < 0.22) detailed = u_artifact;
  }

  float detailMix = smoothstep(${DETAIL_FADE_START.toFixed(1)}, ${DETAIL_FADE_END.toFixed(1)}, u_cellSize);
  outColor = vec4(mix(stateColor, detailed, detailMix), 1.0);
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
uniform vec3 u_lodColors[${SQUARE_SPRITE_COUNT}];

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
  version: string;
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
  genericProgram: WebGLProgram;
  pixelProgram: WebGLProgram;
  vertexArray: WebGLVertexArrayObject;
  genericVertexArray: WebGLVertexArrayObject;
  pixelVertexArray: WebGLVertexArrayObject;
  instanceBuffer: WebGLBuffer;
  genericInstanceBuffer: WebGLBuffer;
  atlasTexture: WebGLTexture;
  genericAtlasTexture: WebGLTexture;
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
  backgroundUniform: WebGLUniformLocation;
  markedUniform: WebGLUniformLocation;
  explodedUniform: WebGLUniformLocation;
  lodColorsUniform: WebGLUniformLocation;
  genericViewportUniform: WebGLUniformLocation;
  genericCameraWorldUniform: WebGLUniformLocation;
  genericCellSizeUniform: WebGLUniformLocation;
  genericDprUniform: WebGLUniformLocation;
  genericArtifactUniform: WebGLUniformLocation;
  genericArtifactEdgeUniform: WebGLUniformLocation;
  genericLodArtifactUniform: WebGLUniformLocation;
  genericCellUniform: WebGLUniformLocation;
  genericCellBorderUniform: WebGLUniformLocation;
  genericBackgroundUniform: WebGLUniformLocation;
  genericMarkedUniform: WebGLUniformLocation;
  genericExplodedUniform: WebGLUniformLocation;
  genericLodColorsUniform: WebGLUniformLocation;
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
    topology: "square",
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
    frontierCells: 0,
    frontierEdges: 0,
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
  private frontierCellCount = 0;
  private frontierEdgeCount = 0;
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
  private genericAnchorWorldX = 0;
  private genericAnchorWorldY = 0;
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
  private screenCaptureRaw = new Uint8Array(0);
  private screenCaptureImage: ImageData | null = null;
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
    const atlas = this.createAtlas(SQUARE_MAX_CLUE_SPRITE, SQUARE_FLAG_SPRITE, SQUARE_QUESTION_SPRITE, SQUARE_EXPLODED_SPRITE);
    const genericAtlas = this.createAtlas(MAX_CLUE_SPRITE, FLAG_SPRITE, QUESTION_SPRITE, EXPLODED_SPRITE);
    gl.bindTexture(gl.TEXTURE_2D, this.resources.atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.bindTexture(gl.TEXTURE_2D, this.resources.genericAtlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, genericAtlas);
    this.applyTheme(this.resources, atlas, genericAtlas);
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
    const worldX = (screenX - this.width / 2 - this.panX) / previousSize;
    const worldY = (screenY - this.height / 2 - this.panY) / previousSize;
    const nextZoom = Math.max(MIN_ZOOM, Math.min(2.2, this.zoom * factor));
    if (nextZoom === this.zoom) return;
    this.zoom = nextZoom;
    const nextSize = this.cellSize;
    this.panX = screenX - this.width / 2 - worldX * nextSize;
    this.panY = screenY - this.height / 2 - worldY * nextSize;
    this.requestRender();
  }

  screenToCell(screenX: number, screenY: number): { x: number; y: number } {
    const origin = this.model.topology.origin;
    return this.model.topology.hitTest(
      origin.x + (screenX - this.width / 2 - this.panX) / this.cellSize,
      origin.y + (screenY - this.height / 2 - this.panY) / this.cellSize,
    );
  }

  copyScreenBounds(
    context: CanvasRenderingContext2D,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): { sourceX: number; sourceY: number; width: number; height: number } {
    const requestedPixelLeft = Math.floor(left * this.dpr);
    const requestedPixelTop = Math.floor(top * this.dpr);
    const requestedPixelRight = Math.ceil(right * this.dpr);
    const requestedPixelBottom = Math.ceil(bottom * this.dpr);
    const pixelWidth = Math.min(this.canvas.width, Math.max(1, requestedPixelRight - requestedPixelLeft));
    const pixelHeight = Math.min(this.canvas.height, Math.max(1, requestedPixelBottom - requestedPixelTop));
    const sourcePixelX = Math.min(
      Math.max(0, this.canvas.width - pixelWidth),
      Math.max(0, requestedPixelLeft),
    );
    const sourcePixelY = Math.min(
      Math.max(0, this.canvas.height - pixelHeight),
      Math.max(0, requestedPixelTop),
    );
    const sourceBottom = this.canvas.height - sourcePixelY - pixelHeight;
    const byteLength = pixelWidth * pixelHeight * 4;
    if (this.screenCaptureRaw.length !== byteLength) this.screenCaptureRaw = new Uint8Array(byteLength);
    let captureImage = this.screenCaptureImage;
    if (!captureImage || captureImage.width !== pixelWidth || captureImage.height !== pixelHeight) {
      captureImage = context.createImageData(pixelWidth, pixelHeight);
      this.screenCaptureImage = captureImage;
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.readPixels(
      sourcePixelX,
      sourceBottom,
      pixelWidth,
      pixelHeight,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      this.screenCaptureRaw,
    );
    const rowBytes = pixelWidth * 4;
    for (let targetY = 0; targetY < pixelHeight; targetY += 1) {
      const sourceY = pixelHeight - targetY - 1;
      captureImage.data.set(
        this.screenCaptureRaw.subarray(sourceY * rowBytes, (sourceY + 1) * rowBytes),
        targetY * rowBytes,
      );
    }
    if (context.canvas.width !== pixelWidth) context.canvas.width = pixelWidth;
    if (context.canvas.height !== pixelHeight) context.canvas.height = pixelHeight;
    context.putImageData(captureImage, 0, 0);
    return {
      sourceX: sourcePixelX / this.dpr,
      sourceY: sourcePixelY / this.dpr,
      width: pixelWidth / this.dpr,
      height: pixelHeight / this.dpr,
    };
  }

  cellScreenPolygon(x: number, y: number): WorldPoint[] {
    const origin = this.model.topology.origin;
    return this.model.topology.geometry(x, y).vertices.map((point) => ({
      x: this.width / 2 + this.panX + (point.x - origin.x) * this.cellSize,
      y: this.height / 2 + this.panY + (point.y - origin.y) * this.cellSize,
    }));
  }

  setHoverCells(cells: ReadonlyArray<{ x: number; y: number }>): void {
    const unique = new Map<string, { x: number; y: number }>();
    for (const cell of cells) {
      if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y)) continue;
      unique.set(`${cell.x},${cell.y}`, { x: cell.x, y: cell.y });
    }
    const next = [...unique.values()].slice(0, this.model.topology.maxNeighbors + 1);
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

    const squareTopology = this.model.topologyId === "square";
    const topologyOrigin = this.model.topology.origin;
    const cameraWorldX = topologyOrigin.x - this.panX / cellSize;
    const cameraWorldY = topologyOrigin.y - this.panY / cellSize;
    const centerWorldX = squareTopology ? cameraWorldX + 0.5 : cameraWorldX;
    const centerWorldY = squareTopology ? cameraWorldY + 0.5 : cameraWorldY;
    const detailMix = this.detailMix(cellSize);
    const pixelLod = cellSize <= SPARSE_LOD_THRESHOLD;
    const usePixelTexture = squareTopology && pixelLod;
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
    if (!squareTopology) {
      const visibleWorldBounds = this.worldViewportBounds(0);
      const overscanCss = pixelLod ? PIXEL_LOD_OVERSCAN_CSS : cellSize * RENDER_TILE_CELLS;
      const renderWorldBounds = this.worldViewportBounds(overscanCss);
      const required = this.model.topology.cellRangeForWorldBounds(visibleWorldBounds);
      const rendered = this.model.topology.cellRangeForWorldBounds(renderWorldBounds);
      const anchorCell = this.model.topology.hitTest(cameraWorldX, cameraWorldY);
      const anchorCells = pixelLod ? SPARSE_ANCHOR_CELLS : RENDER_TILE_CELLS * 8;
      const anchorCellX = floorDiv(anchorCell.x + anchorCells / 2, anchorCells) * anchorCells;
      const anchorCellY = floorDiv(anchorCell.y + anchorCells / 2, anchorCells) * anchorCells;
      anchorX = anchorCellX / RENDER_TILE_CELLS;
      anchorY = anchorCellY / RENDER_TILE_CELLS;
      minX = rendered.minX;
      minY = rendered.minY;
      maxX = rendered.maxX;
      maxY = rendered.maxY;
      requiredMinX = required.minX;
      requiredMinY = required.minY;
      requiredMaxX = required.maxX;
      requiredMaxY = required.maxY;
    } else if (pixelLod) {
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
      if (!squareTopology) this.rebuildGenericInstances(anchorX, anchorY, minX, minY, maxX, maxY);
      else if (pixelLod) this.rebuildPixelTexture(anchorX, anchorY, minX, minY, maxX, maxY);
      else this.rebuildInstances(anchorX, anchorY, minX, minY, maxX, maxY);
    }

    const relativeCameraX = squareTopology
      ? centerWorldX - anchorX * RENDER_TILE_CELLS
      : cameraWorldX - this.genericAnchorWorldX;
    const relativeCameraY = squareTopology
      ? centerWorldY - anchorY * RENDER_TILE_CELLS
      : cameraWorldY - this.genericAnchorWorldY;
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
        frontierCells: this.frontierCellCount,
        frontierEdges: this.frontierEdgeCount,
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
    const drawCalls = this.drawScene(usePixelTexture, !squareTopology, relativeCameraX, relativeCameraY, cellSize, drawRects);
    if (redrawMode === "full") this.fullRedraws += 1;
    else if (redrawMode === "damage") this.damageRedraws += 1;
    else this.panRedraws += 1;
    this.captureRetainedState();

    const visibleMin = this.screenToCell(0, 0);
    const visibleMax = this.screenToCell(this.width, this.height);
    this.frameCount += 1;
    this.diagnostics = {
      backend: "webgl2",
      topology: this.model.topologyId,
      lod,
      cellSize,
      borderCssPixels: cellSize >= 3 ? 1 : 0,
      glyphs: detailMix > 0,
      detailMix,
      backgroundColor: this.theme.background,
      frameCount: this.frameCount,
      frameMs: performance.now() - startedAt,
      visibleCells: Math.abs((visibleMax.x - visibleMin.x + 1) * (visibleMax.y - visibleMin.y + 1)),
      drawnCells: this.instanceCount,
      frontierCells: this.frontierCellCount,
      frontierEdges: this.frontierEdgeCount,
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
    pixelTexture: boolean,
    genericTopology: boolean,
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
    if (pixelTexture) {
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
    } else if (genericTopology) {
      gl.useProgram(resources.genericProgram);
      gl.bindVertexArray(resources.genericVertexArray);
      gl.uniform2f(resources.genericViewportUniform, this.width, this.height);
      gl.uniform2f(resources.genericCameraWorldUniform, relativeCameraX, relativeCameraY);
      gl.uniform1f(resources.genericCellSizeUniform, cellSize);
      gl.uniform1f(resources.genericDprUniform, this.dpr);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, resources.genericAtlasTexture);
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
      if (pixelTexture) gl.drawArrays(gl.TRIANGLES, 0, 6);
      else gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
      drawCalls += 1;
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
    return drawCalls;
  }

  private damageRect(bounds: ExploredBounds, cellSize: number): PixelRect | null {
    if (this.model.topologyId !== "square") {
      const world = this.model.topology.worldBoundsForCellRange(bounds);
      const origin = this.model.topology.origin;
      const dependencyPadding = this.model.topology.maxCellRadius * 2;
      const leftCss = this.width / 2 + this.panX + (world.minX - origin.x - dependencyPadding) * cellSize;
      const rightCss = this.width / 2 + this.panX + (world.maxX - origin.x + dependencyPadding) * cellSize;
      const topCss = this.height / 2 + this.panY + (world.minY - origin.y - dependencyPadding) * cellSize;
      const bottomCss = this.height / 2 + this.panY + (world.maxY - origin.y + dependencyPadding) * cellSize;
      const left = Math.max(0, Math.floor(leftCss * this.dpr) - 1);
      const right = Math.min(this.canvas.width, Math.ceil(rightCss * this.dpr) + 1);
      const top = Math.max(0, Math.floor(topCss * this.dpr) - 1);
      const bottom = Math.min(this.canvas.height, Math.ceil(bottomCss * this.dpr) + 1);
      if (left >= right || top >= bottom) return null;
      return { x: left, y: this.canvas.height - bottom, width: right - left, height: bottom - top };
    }
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
    if (this.model.topologyId !== "square") {
      const world = this.model.topology.worldBoundsForCellRange(bounds);
      const worldWidth = Math.max(1e-6, world.maxX - world.minX);
      const worldHeight = Math.max(1e-6, world.maxY - world.minY);
      const padding = 24;
      const scale = Math.min((cssWidth - padding * 2) / worldWidth, (cssHeight - padding * 2) / worldHeight, 22);
      const originX = (cssWidth - worldWidth * scale) / 2 - world.minX * scale;
      const originY = (cssHeight - worldHeight * scale) / 2 - world.minY * scale;
      this.model.store.forEachNonZero((x, y, state) => {
        if (isOpened(state)) context.fillStyle = state === CellState.Opened && this.model.artifactAt(x, y) ? this.theme.artifact : this.theme.overviewOpened;
        else if (state === CellState.Exploded) context.fillStyle = this.theme.exploded;
        else if (state === CellState.Flagged) context.fillStyle = this.theme.flag;
        else return;
        const vertices = this.model.topology.geometry(x, y).vertices;
        context.beginPath();
        for (let index = 0; index < vertices.length; index += 1) {
          const pointX = originX + vertices[index].x * scale;
          const pointY = originY + vertices[index].y * scale;
          if (index === 0) context.moveTo(pointX, pointY);
          else context.lineTo(pointX, pointY);
        }
        context.closePath();
        context.fill();
      });
      const origin = this.model.topology.origin;
      context.fillStyle = this.theme.background;
      context.strokeStyle = this.theme.ink;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(originX + origin.x * scale, originY + origin.y * scale, Math.max(3, scale * 0.45), 0, Math.PI * 2);
      context.fill();
      context.stroke();
      return `${this.model.topology.label} · ${this.model.store.openedCells.toLocaleString()} revealed`;
    }
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
      if (isOpened(state)) context.fillStyle = state === CellState.Opened && this.model.artifactAt(x, y) ? this.theme.artifact : this.theme.overviewOpened;
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

  private worldViewportBounds(paddingCss: number): WorldBounds {
    const cellSize = this.cellSize;
    const origin = this.model.topology.origin;
    return {
      minX: origin.x + (-paddingCss - this.width / 2 - this.panX) / cellSize,
      minY: origin.y + (-paddingCss - this.height / 2 - this.panY) / cellSize,
      maxX: origin.x + (this.width + paddingCss - this.width / 2 - this.panX) / cellSize,
      maxY: origin.y + (this.height + paddingCss - this.height / 2 - this.panY) / cellSize,
    };
  }

  private rebuildGenericInstances(
    anchorX: number,
    anchorY: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    const topology = this.model.topology;
    const anchorCellX = anchorX * RENDER_TILE_CELLS;
    const anchorCellY = anchorY * RENDER_TILE_CELLS;
    const anchor = topology.geometry(anchorCellX, anchorCellY).center;
    this.genericAnchorWorldX = anchor.x;
    this.genericAnchorWorldY = anchor.y;
    const cellKey = (x: number, y: number) => `${x},${y}`;
    const detailFrontier = this.cellSize > SPARSE_LOD_THRESHOLD;
    const renderCells = detailFrontier
      ? new Map<string, { x: number; y: number; state: CellState; frontier: boolean }>()
      : null;
    if (renderCells) {
      const sourceCells: Array<{ x: number; y: number; state: CellState }> = [];
      this.model.store.forEachNonZeroInBounds(minX, minY, maxX, maxY, (x, y, state) => {
        const cell = { x, y, state };
        sourceCells.push(cell);
        renderCells.set(cellKey(x, y), { ...cell, frontier: false });
      });
      for (const source of sourceCells) {
        if (!this.isUncovered(source.state)) continue;
        for (const neighbor of topology.edgeNeighbors(source.x, source.y)) {
          const { x, y } = neighbor;
          if (x < minX || x > maxX || y < minY || y > maxY) continue;
          const key = cellKey(x, y);
          if (renderCells.has(key) || this.model.getState(x, y) !== CellState.Covered) continue;
          renderCells.set(key, { x, y, state: CellState.Covered, frontier: true });
        }
      }
    }
    const storedCapacity = Math.max(
      1,
      Math.min(this.model.store.nonZeroCells, (maxX - minX + 1) * (maxY - minY + 1)),
    );
    const instances = new Float32Array(
      Math.max(1, renderCells?.size ?? storedCapacity) * GENERIC_INSTANCE_FLOATS,
    );
    let index = 0;
    let frontierCells = 0;
    let frontierEdges = 0;

    const appendCell = (x: number, y: number, state: CellState, frontier: boolean) => {
      if (index + GENERIC_INSTANCE_FLOATS > instances.length) return;
      const geometry = topology.geometry(x, y);
      let drawCenterX = geometry.center.x;
      let drawCenterY = geometry.center.y;
      if (geometry.shape === "triangle-up" || geometry.shape === "triangle-down") {
        let geometryMinX = geometry.vertices[0].x;
        let geometryMaxX = geometry.vertices[0].x;
        let geometryMinY = geometry.vertices[0].y;
        let geometryMaxY = geometry.vertices[0].y;
        for (let vertex = 1; vertex < geometry.vertices.length; vertex += 1) {
          geometryMinX = Math.min(geometryMinX, geometry.vertices[vertex].x);
          geometryMaxX = Math.max(geometryMaxX, geometry.vertices[vertex].x);
          geometryMinY = Math.min(geometryMinY, geometry.vertices[vertex].y);
          geometryMaxY = Math.max(geometryMaxY, geometry.vertices[vertex].y);
        }
        drawCenterX = (geometryMinX + geometryMaxX) / 2;
        drawCenterY = (geometryMinY + geometryMaxY) / 2;
      }
      const edgeNeighbors = topology.edgeNeighbors(x, y);
      let edges = frontier ? this.frontierContinuationEdges(x, y) : 0;
      if (!frontier) {
        for (let edge = 0; edge < edgeNeighbors.length; edge += 1) {
          const neighbor = edgeNeighbors[edge];
          if (
            compareCells({ x, y }, neighbor) < 0 ||
            !this.isRenderable(this.model.getState(neighbor.x, neighbor.y))
          ) {
            edges |= 1 << edge;
          }
        }
      }
      const shape = geometry.shape === "triangle-up" ? 1 : geometry.shape === "triangle-down" ? 2 : 3;
      instances[index++] = drawCenterX - anchor.x;
      instances[index++] = drawCenterY - anchor.y;
      instances[index++] = geometry.axisU.x;
      instances[index++] = geometry.axisU.y;
      instances[index++] = geometry.axisV.x;
      instances[index++] = geometry.axisV.y;
      instances[index++] = frontier ? 0 : this.spriteFor(state);
      instances[index++] = frontier
        ? FRONTIER_CELL_KIND
        : state === CellState.Opened && this.model.artifactAt(x, y)
          ? ARTIFACT_CELL_KIND
          : 0;
      instances[index++] = shape;
      instances[index++] = edges;
      if (frontier) {
        frontierCells += 1;
        frontierEdges += this.edgeCount(edges);
      }
    };

    if (renderCells) {
      for (const cell of renderCells.values()) appendCell(cell.x, cell.y, cell.state, cell.frontier);
    } else {
      this.model.store.forEachNonZeroInBounds(minX, minY, maxX, maxY, (x, y, state) => {
        appendCell(x, y, state, false);
      });
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.resources.genericInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances.subarray(0, index), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.instanceUploads += 1;
    this.instanceCount = index / GENERIC_INSTANCE_FLOATS;
    this.frontierCellCount = frontierCells;
    this.frontierEdgeCount = frontierEdges;
    this.range = {
      lod: this.cellSize <= SPARSE_LOD_THRESHOLD ? "pixel" : "detail",
      anchorX,
      anchorY,
      minX,
      minY,
      maxX,
      maxY,
      generation: this.model.store.generation,
      version: this.model.store.version,
    };
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
    let frontierCells = 0;
    let frontierEdges = 0;
    for (const tile of visibleTiles) {
      for (let source = 0; source < tile.cells.length; source += CACHED_CELL_FLOATS) {
        const localX = tile.cells[source];
        const localY = tile.cells[source + 1];
        const worldX = tile.worldOriginX + localX;
        const worldY = tile.worldOriginY + localY;
        const frontier = tile.cells[source + 3] === FRONTIER_CELL_KIND;
        // Every grid line belongs to the cell below/right of it. Exposed right/bottom
        // lines are therefore extended into the otherwise unrendered neighbor.
        let edges = frontier ? this.squareFrontierContinuationEdges(worldX, worldY) : 1 | 2;
        if (!frontier && !this.isRenderable(this.model.getState(worldX + 1, worldY))) edges |= 4;
        if (!frontier && !this.isRenderable(this.model.getState(worldX, worldY + 1))) edges |= 8;
        instances[instanceIndex++] = tile.relativeOriginX + localX;
        instances[instanceIndex++] = tile.relativeOriginY + localY;
        instances[instanceIndex++] = tile.cells[source + 2];
        instances[instanceIndex++] = tile.cells[source + 3];
        instances[instanceIndex++] = edges;
        if (frontier) {
          frontierCells += 1;
          frontierEdges += this.edgeCount(edges);
        }
      }
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.resources.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances.subarray(0, instanceIndex), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.instanceUploads += 1;
    this.instanceCount = instanceIndex / INSTANCE_FLOATS;
    this.frontierCellCount = frontierCells;
    this.frontierEdgeCount = frontierEdges;
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
      const sprite = this.squareSpriteFor(state);
      const artifact = state === CellState.Opened && this.model.artifactAt(x, y) ? 16 : 0;
      statePixels[(y - textureOriginY) * textureWidth + x - textureOriginX] = sprite + 1 + artifact;
    });

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.resources.stateTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, textureWidth, textureHeight, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, statePixels);
    this.instanceUploads += 1;
    this.instanceCount = visibleStates;
    this.frontierCellCount = 0;
    this.frontierEdgeCount = 0;
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
    const version = this.squareTileVersion(tileX, tileY);
    const existing = this.tileCache.get(key);
    if (existing?.generation === this.model.store.generation && existing.version === version) {
      this.tileCache.delete(key);
      this.tileCache.set(key, existing);
      return existing.cells;
    }

    const originX = tileX * RENDER_TILE_CELLS;
    const originY = tileY * RENDER_TILE_CELLS;
    const renderCells = new Map<
      number,
      { localX: number; localY: number; state: CellState; frontier: boolean }
    >();
    this.model.store.forEachNonZeroInBounds(
      originX - 1,
      originY - 1,
      originX + RENDER_TILE_CELLS,
      originY + RENDER_TILE_CELLS,
      (x, y, state) => {
        const localX = x - originX;
        const localY = y - originY;
        if (
          localX >= 0 &&
          localX < RENDER_TILE_CELLS &&
          localY >= 0 &&
          localY < RENDER_TILE_CELLS
        ) {
          renderCells.set(localY * RENDER_TILE_CELLS + localX, { localX, localY, state, frontier: false });
        }
        if (!this.isUncovered(state)) return;
        for (const neighbor of this.model.topology.edgeNeighbors(x, y)) {
          const frontierX = neighbor.x - originX;
          const frontierY = neighbor.y - originY;
          if (
            frontierX < 0 ||
            frontierX >= RENDER_TILE_CELLS ||
            frontierY < 0 ||
            frontierY >= RENDER_TILE_CELLS ||
            this.model.getState(neighbor.x, neighbor.y) !== CellState.Covered
          ) {
            continue;
          }
          const frontierIndex = frontierY * RENDER_TILE_CELLS + frontierX;
          if (!renderCells.has(frontierIndex)) {
            renderCells.set(frontierIndex, {
              localX: frontierX,
              localY: frontierY,
              state: CellState.Covered,
              frontier: true,
            });
          }
        }
      },
    );

    const cells = new Float32Array(Math.min(CELLS_PER_TILE, renderCells.size) * CACHED_CELL_FLOATS);
    let index = 0;
    for (const cell of renderCells.values()) {
      if (index + CACHED_CELL_FLOATS > cells.length) break;
      cells[index++] = cell.localX;
      cells[index++] = cell.localY;
      cells[index++] = cell.frontier ? 0 : this.squareSpriteFor(cell.state);
      cells[index++] = cell.frontier
        ? FRONTIER_CELL_KIND
        : cell.state === CellState.Opened && this.model.artifactAt(originX + cell.localX, originY + cell.localY)
          ? ARTIFACT_CELL_KIND
          : 0;
    }

    const tile: CachedTile = {
      cells: cells.slice(0, index),
      generation: this.model.store.generation,
      version,
    };
    this.tileCache.set(key, tile);
    return tile.cells;
  }

  private squareTileVersion(tileX: number, tileY: number): string {
    let version = "";
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        version += `${this.model.store.getTileVersion(tileX + offsetX, tileY + offsetY)},`;
      }
    }
    return version;
  }

  private squareFrontierContinuationEdges(x: number, y: number): number {
    let edges = 0;
    if (this.isUncovered(this.model.getState(x, y - 1))) edges |= 1 | 2 | 4;
    if (this.isUncovered(this.model.getState(x + 1, y))) edges |= 1 | 4 | 8;
    if (this.isUncovered(this.model.getState(x, y + 1))) edges |= 2 | 4 | 8;
    if (this.isUncovered(this.model.getState(x - 1, y))) edges |= 1 | 2 | 8;
    return edges;
  }

  private frontierContinuationEdges(x: number, y: number): number {
    const edgeNeighbors = this.model.topology.edgeNeighbors(x, y);
    let edges = 0;
    for (let sharedEdge = 0; sharedEdge < edgeNeighbors.length; sharedEdge += 1) {
      const neighbor = edgeNeighbors[sharedEdge];
      if (!this.isUncovered(this.model.getState(neighbor.x, neighbor.y))) continue;
      edges |= 1 << sharedEdge;
      edges |= 1 << ((sharedEdge + edgeNeighbors.length - 1) % edgeNeighbors.length);
      edges |= 1 << ((sharedEdge + 1) % edgeNeighbors.length);
    }
    return edges;
  }

  private edgeCount(edges: number): number {
    let remaining = edges;
    let count = 0;
    while (remaining > 0) {
      count += remaining & 1;
      remaining >>>= 1;
    }
    return count;
  }

  private spriteFor(state: CellState): number {
    if (isOpened(state)) return openedClue(state);
    if (state === CellState.Flagged) return FLAG_SPRITE;
    if (state === CellState.Question) return QUESTION_SPRITE;
    return EXPLODED_SPRITE;
  }

  private squareSpriteFor(state: CellState): number {
    if (isOpened(state)) return Math.min(SQUARE_MAX_CLUE_SPRITE, openedClue(state));
    if (state === CellState.Flagged) return SQUARE_FLAG_SPRITE;
    if (state === CellState.Question) return SQUARE_QUESTION_SPRITE;
    return SQUARE_EXPLODED_SPRITE;
  }

  private isRenderable(state: CellState): boolean {
    return state !== CellState.Covered && state !== CellState.Queued;
  }

  private isUncovered(state: CellState): boolean {
    return isOpened(state) || state === CellState.Exploded;
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
    this.frontierCellCount = 0;
    this.frontierEdgeCount = 0;
  }

  private createResources(): GlResources {
    const gl = this.gl;
    const program = requireProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    const genericProgram = requireProgram(gl, GENERIC_VERTEX_SHADER, GENERIC_FRAGMENT_SHADER);
    const pixelProgram = requireProgram(gl, PIXEL_VERTEX_SHADER, PIXEL_FRAGMENT_SHADER);
    const vertexArray = gl.createVertexArray();
    const genericVertexArray = gl.createVertexArray();
    const pixelVertexArray = gl.createVertexArray();
    const quadBuffer = gl.createBuffer();
    const instanceBuffer = gl.createBuffer();
    const genericInstanceBuffer = gl.createBuffer();
    const atlasTexture = gl.createTexture();
    const genericAtlasTexture = gl.createTexture();
    const stateTexture = gl.createTexture();
    const scratchTexture = gl.createTexture();
    const scratchFramebuffer = gl.createFramebuffer();
    if (
      !vertexArray ||
      !genericVertexArray ||
      !pixelVertexArray ||
      !quadBuffer ||
      !instanceBuffer ||
      !genericInstanceBuffer ||
      !atlasTexture ||
      !genericAtlasTexture ||
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

    gl.bindVertexArray(genericVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, genericInstanceBuffer);
    const genericStride = GENERIC_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, genericStride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, genericStride, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, genericStride, 8 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    gl.bindVertexArray(pixelVertexArray);
    gl.bindVertexArray(null);

    const atlas = this.createAtlas(SQUARE_MAX_CLUE_SPRITE, SQUARE_FLAG_SPRITE, SQUARE_QUESTION_SPRITE, SQUARE_EXPLODED_SPRITE);
    const genericAtlas = this.createAtlas(MAX_CLUE_SPRITE, FLAG_SPRITE, QUESTION_SPRITE, EXPLODED_SPRITE);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, genericAtlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, genericAtlas);
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
    gl.useProgram(genericProgram);
    gl.uniform1i(requireUniform(gl, genericProgram, "u_atlas"), 0);
    gl.useProgram(pixelProgram);
    gl.uniform1i(requireUniform(gl, pixelProgram, "u_stateTexture"), 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    const resources = {
      program,
      genericProgram,
      pixelProgram,
      vertexArray,
      genericVertexArray,
      pixelVertexArray,
      instanceBuffer,
      genericInstanceBuffer,
      atlasTexture,
      genericAtlasTexture,
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
      backgroundUniform: requireUniform(gl, program, "u_background"),
      markedUniform: requireUniform(gl, program, "u_marked"),
      explodedUniform: requireUniform(gl, program, "u_exploded"),
      lodColorsUniform: requireUniform(gl, program, "u_lodColors[0]"),
      genericViewportUniform: requireUniform(gl, genericProgram, "u_viewport"),
      genericCameraWorldUniform: requireUniform(gl, genericProgram, "u_cameraWorld"),
      genericCellSizeUniform: requireUniform(gl, genericProgram, "u_cellSize"),
      genericDprUniform: requireUniform(gl, genericProgram, "u_dpr"),
      genericArtifactUniform: requireUniform(gl, genericProgram, "u_artifact"),
      genericArtifactEdgeUniform: requireUniform(gl, genericProgram, "u_artifactEdge"),
      genericLodArtifactUniform: requireUniform(gl, genericProgram, "u_lodArtifact"),
      genericCellUniform: requireUniform(gl, genericProgram, "u_cell"),
      genericCellBorderUniform: requireUniform(gl, genericProgram, "u_cellBorder"),
      genericBackgroundUniform: requireUniform(gl, genericProgram, "u_background"),
      genericMarkedUniform: requireUniform(gl, genericProgram, "u_marked"),
      genericExplodedUniform: requireUniform(gl, genericProgram, "u_exploded"),
      genericLodColorsUniform: requireUniform(gl, genericProgram, "u_lodColors[0]"),
      pixelViewportUniform: requireUniform(gl, pixelProgram, "u_viewport"),
      pixelCameraCellUniform: requireUniform(gl, pixelProgram, "u_cameraCell"),
      pixelTextureOriginUniform: requireUniform(gl, pixelProgram, "u_textureOrigin"),
      pixelTextureSizeUniform: requireUniform(gl, pixelProgram, "u_textureSize"),
      pixelCellSizeUniform: requireUniform(gl, pixelProgram, "u_cellSize"),
      pixelDprUniform: requireUniform(gl, pixelProgram, "u_dpr"),
      pixelLodArtifactUniform: requireUniform(gl, pixelProgram, "u_lodArtifact"),
      pixelLodColorsUniform: requireUniform(gl, pixelProgram, "u_lodColors[0]"),
    };
    this.applyTheme(resources, atlas, genericAtlas);
    return resources;
  }

  private applyTheme(resources: GlResources, atlas: HTMLCanvasElement, genericAtlas: HTMLCanvasElement): void {
    const gl = this.gl;
    const lodColors = this.createLodColors(
      atlas,
      SQUARE_SPRITE_COUNT,
      SQUARE_FLAG_SPRITE,
      SQUARE_EXPLODED_SPRITE,
    );
    const genericLodColors = this.createLodColors(genericAtlas, SPRITE_COUNT, FLAG_SPRITE, EXPLODED_SPRITE);
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
    gl.uniform3fv(resources.backgroundUniform, this.theme.backgroundRgb);
    gl.uniform3fv(resources.markedUniform, hexToRgb(this.theme.marked));
    gl.uniform3fv(resources.explodedUniform, hexToRgb(this.theme.exploded));
    gl.uniform3fv(resources.lodColorsUniform, lodColors);
    gl.useProgram(resources.genericProgram);
    gl.uniform3fv(resources.genericArtifactUniform, this.theme.artifactRgb);
    gl.uniform3fv(resources.genericArtifactEdgeUniform, this.theme.artifactEdgeRgb);
    gl.uniform3fv(resources.genericLodArtifactUniform, artifactLod);
    gl.uniform3fv(resources.genericCellUniform, cell);
    gl.uniform3fv(resources.genericCellBorderUniform, hexToRgb(this.theme.cellBorder));
    gl.uniform3fv(resources.genericBackgroundUniform, this.theme.backgroundRgb);
    gl.uniform3fv(resources.genericMarkedUniform, hexToRgb(this.theme.marked));
    gl.uniform3fv(resources.genericExplodedUniform, hexToRgb(this.theme.exploded));
    gl.uniform3fv(resources.genericLodColorsUniform, genericLodColors);
    gl.useProgram(resources.pixelProgram);
    gl.uniform3fv(resources.pixelLodArtifactUniform, artifactLod);
    gl.uniform3fv(resources.pixelLodColorsUniform, lodColors);
  }

  private createLodColors(
    atlas: HTMLCanvasElement,
    spriteCount: number,
    flagSprite: number,
    explodedSprite: number,
  ): Float32Array {
    const context = atlas.getContext("2d");
    if (!context) throw new Error("Unable to sample sprite atlas");
    const pixels = context.getImageData(0, 0, atlas.width, atlas.height).data;
    const colors = new Float32Array(spriteCount * 3);
    const cell = hexToRgb(this.theme.cell);
    const marked = hexToRgb(this.theme.marked);
    const exploded = hexToRgb(this.theme.exploded);
    const spriteArea = SPRITE_PIXELS * SPRITE_PIXELS;
    for (let sprite = 0; sprite < spriteCount; sprite += 1) {
      const base = sprite === explodedSprite ? exploded : sprite >= flagSprite ? marked : cell;
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
      numbers: Array.from({ length: MAX_CLUE_SPRITE + 1 }, (_, index) =>
        color(`--board-number-${Math.min(index, 8)}`),
      ),
    };
  }

  private createAtlas(maxClue: number, flagSprite: number, questionSprite: number, explodedSprite: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    const spriteCount = explodedSprite + 1;
    canvas.width = SPRITE_PIXELS * spriteCount;
    canvas.height = SPRITE_PIXELS;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create sprite atlas");
    for (let sprite = 0; sprite < spriteCount; sprite += 1) {
      this.drawSprite(context, sprite * SPRITE_PIXELS, SPRITE_PIXELS, sprite, maxClue, flagSprite, questionSprite, explodedSprite);
    }
    return canvas;
  }

  private drawSprite(
    context: CanvasRenderingContext2D,
    left: number,
    size: number,
    sprite: number,
    maxClue: number,
    flagSprite: number,
    questionSprite: number,
    explodedSprite: number,
  ): void {
    const theme = this.theme;
    context.clearRect(left, 0, size, size);

    if (sprite >= 1 && sprite <= maxClue) {
      context.fillStyle = theme.numbers[sprite];
      context.font = `800 ${Math.round(size * 0.62)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(sprite), left + size / 2, size * 0.53);
    } else if (sprite === flagSprite) {
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
    } else if (sprite === questionSprite) {
      context.fillStyle = theme.question;
      context.font = `800 ${Math.round(size * 0.7)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("?", left + size / 2, size * 0.52);
    } else if (sprite === explodedSprite) {
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
