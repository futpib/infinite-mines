export const TOPOLOGY_IDS = ["square", "triangular", "rhombille"] as const;
export type TopologyId = (typeof TOPOLOGY_IDS)[number];

export interface CellRef {
  x: number;
  y: number;
}

export interface WorldPoint {
  x: number;
  y: number;
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CellRange {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type CellShape = "square" | "triangle-up" | "triangle-down" | "rhombus";

export interface CellGeometry {
  center: WorldPoint;
  vertices: readonly WorldPoint[];
  shape: CellShape;
  /** Half-axes of the instanced bounding parallelogram. */
  axisU: WorldPoint;
  axisV: WorldPoint;
}

export interface Topology {
  readonly id: TopologyId;
  readonly label: string;
  readonly origin: WorldPoint;
  readonly maxNeighbors: number;
  readonly maxCellRadius: number;
  forEachNeighbor(x: number, y: number, visitor: (neighborX: number, neighborY: number) => void): void;
  edgeNeighbors(x: number, y: number): readonly CellRef[];
  geometry(x: number, y: number): CellGeometry;
  hitTest(worldX: number, worldY: number): CellRef;
  cellRangeForWorldBounds(bounds: WorldBounds, padding?: number): CellRange;
  worldBoundsForCellRange(range: CellRange): WorldBounds;
}

const SQRT_3 = Math.sqrt(3);
const TRIANGLE_HEIGHT = SQRT_3 / 2;
const RHOMBILLE_LATTICE_X = SQRT_3;
const RHOMBILLE_LATTICE_Y = 1.5;
const EPSILON = 1e-8;

const positiveModulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

const pointInConvexPolygon = (point: WorldPoint, vertices: readonly WorldPoint[]): boolean => {
  let sign = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    if (Math.abs(cross) <= EPSILON) continue;
    const nextSign = cross < 0 ? -1 : 1;
    if (sign !== 0 && nextSign !== sign) return false;
    sign = nextSign;
  }
  return true;
};

const closestContainingCell = (
  worldX: number,
  worldY: number,
  range: CellRange,
  geometry: (x: number, y: number) => CellGeometry,
): CellRef => {
  const point = { x: worldX, y: worldY };
  let closest: CellRef | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let y = range.minY; y <= range.maxY; y += 1) {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      const cell = geometry(x, y);
      const distance = (cell.center.x - worldX) ** 2 + (cell.center.y - worldY) ** 2;
      if (pointInConvexPolygon(point, cell.vertices)) {
        // A boundary belongs deterministically to the nearest center, then the
        // lexicographically smallest canonical ID.
        if (
          distance < closestDistance - EPSILON ||
          (Math.abs(distance - closestDistance) <= EPSILON &&
            (!closest || y < closest.y || (y === closest.y && x < closest.x)))
        ) {
          closest = { x, y };
          closestDistance = distance;
        }
      } else if (!closest && distance < closestDistance) {
        closest = { x, y };
        closestDistance = distance;
      }
    }
  }
  if (!closest) throw new Error("Topology hit-test produced no candidates");
  return closest;
};

const squareGeometry = (x: number, y: number): CellGeometry => ({
  center: { x, y },
  vertices: [
    { x: x - 0.5, y: y - 0.5 },
    { x: x + 0.5, y: y - 0.5 },
    { x: x + 0.5, y: y + 0.5 },
    { x: x - 0.5, y: y + 0.5 },
  ],
  shape: "square",
  axisU: { x: 0.5, y: 0 },
  axisV: { x: 0, y: 0.5 },
});

const SQUARE_NEIGHBORS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

const SQUARE_EDGE_NEIGHBORS: readonly CellRef[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const squareTopology: Topology = {
  id: "square",
  label: "Square",
  origin: { x: 0, y: 0 },
  maxNeighbors: 8,
  maxCellRadius: Math.SQRT1_2,
  forEachNeighbor(x, y, visitor) {
    for (const [offsetX, offsetY] of SQUARE_NEIGHBORS) visitor(x + offsetX, y + offsetY);
  },
  edgeNeighbors(x, y) {
    return SQUARE_EDGE_NEIGHBORS.map((offset) => ({ x: x + offset.x, y: y + offset.y }));
  },
  geometry: squareGeometry,
  hitTest(worldX, worldY) {
    return { x: Math.floor(worldX + 0.5), y: Math.floor(worldY + 0.5) };
  },
  cellRangeForWorldBounds(bounds, padding = 0) {
    return {
      minX: Math.floor(bounds.minX - 0.5) - padding,
      minY: Math.floor(bounds.minY - 0.5) - padding,
      maxX: Math.floor(bounds.maxX + 0.5) + padding,
      maxY: Math.floor(bounds.maxY + 0.5) + padding,
    };
  },
  worldBoundsForCellRange(range) {
    return {
      minX: range.minX - 0.5,
      minY: range.minY - 0.5,
      maxX: range.maxX + 0.5,
      maxY: range.maxY + 0.5,
    };
  },
};

const triangleGeometry = (x: number, y: number): CellGeometry => {
  const left = x * 0.5;
  const top = y * TRIANGLE_HEIGHT;
  const up = positiveModulo(x + y, 2) === 0;
  return {
    center: { x: left + 0.5, y: top + (up ? (TRIANGLE_HEIGHT * 2) / 3 : TRIANGLE_HEIGHT / 3) },
    vertices: up
      ? [
          { x: left, y: top + TRIANGLE_HEIGHT },
          { x: left + 0.5, y: top },
          { x: left + 1, y: top + TRIANGLE_HEIGHT },
        ]
      : [
          { x: left, y: top },
          { x: left + 1, y: top },
          { x: left + 0.5, y: top + TRIANGLE_HEIGHT },
        ],
    shape: up ? "triangle-up" : "triangle-down",
    axisU: { x: 0.5, y: 0 },
    axisV: { x: 0, y: TRIANGLE_HEIGHT / 2 },
  };
};

const TRIANGLE_NEIGHBORS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-2, 0],
    [-1, 0],
    [1, 0],
    [2, 0],
    [-2, 1],
    [-1, 1],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  [
    [-2, -1],
    [-1, -1],
    [0, -1],
    [1, -1],
    [2, -1],
    [-2, 0],
    [-1, 0],
    [1, 0],
    [2, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ],
];

const TRIANGLE_EDGE_NEIGHBORS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [-1, 0],
    [1, 0],
    [0, 1],
  ],
  [
    [0, -1],
    [1, 0],
    [-1, 0],
  ],
];

const triangleTopology: Topology = {
  id: "triangular",
  label: "Triangular",
  origin: { x: 0.5, y: (TRIANGLE_HEIGHT * 2) / 3 },
  maxNeighbors: 12,
  maxCellRadius: 2 / 3,
  forEachNeighbor(x, y, visitor) {
    const variant = positiveModulo(x + y, 2);
    for (const [offsetX, offsetY] of TRIANGLE_NEIGHBORS[variant]) visitor(x + offsetX, y + offsetY);
  },
  edgeNeighbors(x, y) {
    const variant = positiveModulo(x + y, 2);
    return TRIANGLE_EDGE_NEIGHBORS[variant].map(([offsetX, offsetY]) => ({ x: x + offsetX, y: y + offsetY }));
  },
  geometry: triangleGeometry,
  hitTest(worldX, worldY) {
    const approximateY = Math.floor(worldY / TRIANGLE_HEIGHT);
    const approximateX = Math.floor(worldX * 2);
    return closestContainingCell(
      worldX,
      worldY,
      { minX: approximateX - 3, minY: approximateY - 2, maxX: approximateX + 3, maxY: approximateY + 2 },
      triangleGeometry,
    );
  },
  cellRangeForWorldBounds(bounds, padding = 0) {
    return {
      minX: Math.floor(bounds.minX * 2) - 3 - padding * 2,
      minY: Math.floor(bounds.minY / TRIANGLE_HEIGHT) - 2 - padding,
      maxX: Math.ceil(bounds.maxX * 2) + 3 + padding * 2,
      maxY: Math.ceil(bounds.maxY / TRIANGLE_HEIGHT) + 2 + padding,
    };
  },
  worldBoundsForCellRange(range) {
    return {
      minX: range.minX * 0.5,
      minY: range.minY * TRIANGLE_HEIGHT,
      maxX: range.maxX * 0.5 + 1,
      maxY: (range.maxY + 1) * TRIANGLE_HEIGHT,
    };
  },
};

const latticePoint = (u: number, v: number): WorldPoint => ({
  x: u * RHOMBILLE_LATTICE_X + v * (RHOMBILLE_LATTICE_X / 2),
  y: v * RHOMBILLE_LATTICE_Y,
});

const addPoint = (left: WorldPoint, right: WorldPoint): WorldPoint => ({ x: left.x + right.x, y: left.y + right.y });
const scalePoint = (point: WorldPoint, scale: number): WorldPoint => ({ x: point.x * scale, y: point.y * scale });

const rhombilleGeometry = (x: number, y: number): CellGeometry => {
  const slot = positiveModulo(x, 3);
  const u = Math.floor(x / 3);
  const start = latticePoint(u, y);
  const latticeA = { x: RHOMBILLE_LATTICE_X, y: 0 };
  const latticeB = { x: RHOMBILLE_LATTICE_X / 2, y: RHOMBILLE_LATTICE_Y };
  let direction: WorldPoint;
  let thirdA: WorldPoint;
  let thirdB: WorldPoint;
  if (slot === 0) {
    direction = latticeA;
    thirdA = latticeB;
    thirdB = { x: latticeA.x - latticeB.x, y: latticeA.y - latticeB.y };
  } else if (slot === 1) {
    direction = latticeB;
    thirdA = latticeA;
    thirdB = { x: latticeB.x - latticeA.x, y: latticeB.y - latticeA.y };
  } else {
    direction = { x: latticeB.x - latticeA.x, y: latticeB.y - latticeA.y };
    thirdA = latticeB;
    thirdB = { x: -latticeA.x, y: -latticeA.y };
  }

  const end = addPoint(start, direction);
  const centerA = addPoint(start, scalePoint(addPoint(direction, thirdA), 1 / 3));
  const centerB = addPoint(start, scalePoint(addPoint(direction, thirdB), 1 / 3));
  const crossA = direction.x * (centerA.y - start.y) - direction.y * (centerA.x - start.x);
  const negativeCenter = crossA < 0 ? centerA : centerB;
  const positiveCenter = crossA < 0 ? centerB : centerA;
  const center = scalePoint(addPoint(start, end), 0.5);
  return {
    center,
    vertices: [start, negativeCenter, end, positiveCenter],
    shape: "rhombus",
    axisU: scalePoint(direction, 0.5),
    axisV: scalePoint({ x: positiveCenter.x - negativeCenter.x, y: positiveCenter.y - negativeCenter.y }, 0.5),
  };
};

const RHOMBILLE_NEIGHBORS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [1, -1],
    [4, -1],
    [5, -1],
    [8, -1],
    [-3, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
  ],
  [
    [0, -1],
    [4, -1],
    [-4, 0],
    [-1, 0],
    [1, 0],
    [4, 0],
    [-4, 1],
    [-1, 1],
    [0, 1],
    [1, 1],
  ],
  [
    [-1, -1],
    [3, -1],
    [-5, 0],
    [-4, 0],
    [-2, 0],
    [-1, 0],
    [-8, 1],
    [-5, 1],
    [-4, 1],
    [-3, 1],
  ],
];

const RHOMBILLE_EDGE_NEIGHBORS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [5, -1],
    [4, -1],
    [5, 0],
    [1, 0],
  ],
  [
    [-1, 0],
    [4, 0],
    [-4, 1],
    [1, 0],
  ],
  [
    [-1, 0],
    [-5, 1],
    [-4, 0],
    [-5, 0],
  ],
];

const rhombilleCellRange = (bounds: WorldBounds, padding = 0): CellRange => {
  const corners = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.minX, y: bounds.maxY },
    { x: bounds.maxX, y: bounds.maxY },
  ];
  let minU = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;
  for (const corner of corners) {
    const v = corner.y / RHOMBILLE_LATTICE_Y;
    const u = corner.x / RHOMBILLE_LATTICE_X - v / 2;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const latticePadding = 2 + padding;
  return {
    minX: (Math.floor(minU) - latticePadding) * 3,
    minY: Math.floor(minV) - latticePadding,
    maxX: (Math.ceil(maxU) + latticePadding) * 3 + 2,
    maxY: Math.ceil(maxV) + latticePadding,
  };
};

const rhombilleTopology: Topology = {
  id: "rhombille",
  label: "Rhombille",
  origin: { x: SQRT_3 / 2, y: 0 },
  maxNeighbors: 10,
  maxCellRadius: SQRT_3 / 2,
  forEachNeighbor(x, y, visitor) {
    const slot = positiveModulo(x, 3);
    for (const [offsetX, offsetY] of RHOMBILLE_NEIGHBORS[slot]) visitor(x + offsetX, y + offsetY);
  },
  edgeNeighbors(x, y) {
    const slot = positiveModulo(x, 3);
    return RHOMBILLE_EDGE_NEIGHBORS[slot].map(([offsetX, offsetY]) => ({ x: x + offsetX, y: y + offsetY }));
  },
  geometry: rhombilleGeometry,
  hitTest(worldX, worldY) {
    return closestContainingCell(
      worldX,
      worldY,
      rhombilleCellRange({ minX: worldX, minY: worldY, maxX: worldX, maxY: worldY }),
      rhombilleGeometry,
    );
  },
  cellRangeForWorldBounds: rhombilleCellRange,
  worldBoundsForCellRange(range) {
    const minU = Math.floor(range.minX / 3) - 1;
    const maxU = Math.floor(range.maxX / 3) + 1;
    const minV = range.minY - 1;
    const maxV = range.maxY + 1;
    const points = [
      latticePoint(minU, minV),
      latticePoint(maxU + 1, minV),
      latticePoint(minU, maxV + 1),
      latticePoint(maxU + 1, maxV + 1),
    ];
    return {
      minX: Math.min(...points.map((point) => point.x)) - 1,
      minY: Math.min(...points.map((point) => point.y)) - 1,
      maxX: Math.max(...points.map((point) => point.x)) + 1,
      maxY: Math.max(...points.map((point) => point.y)) + 1,
    };
  },
};

export const TOPOLOGIES: Readonly<Record<TopologyId, Topology>> = {
  square: squareTopology,
  triangular: triangleTopology,
  rhombille: rhombilleTopology,
};

export const topologyFor = (id: TopologyId): Topology => TOPOLOGIES[id];

export const isTopologyId = (value: unknown): value is TopologyId =>
  typeof value === "string" && TOPOLOGY_IDS.includes(value as TopologyId);

export const cellsEqual = (left: CellRef, right: CellRef): boolean => left.x === right.x && left.y === right.y;

export const compareCells = (left: CellRef, right: CellRef): number => left.y - right.y || left.x - right.x;
