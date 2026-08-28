import { describe, expect, it } from "vitest";
import { TOPOLOGIES, TOPOLOGY_IDS, type CellRef, type WorldPoint } from "../src/topology";

const samePoint = (left: WorldPoint, right: WorldPoint): boolean =>
  Math.hypot(left.x - right.x, left.y - right.y) < 1e-7;

const sharedVertices = (left: readonly WorldPoint[], right: readonly WorldPoint[]): number =>
  left.filter((point) => right.some((candidate) => samePoint(point, candidate))).length;

const keyFor = (cell: CellRef): string => `${cell.x},${cell.y}`;

describe("topology descriptors", () => {
  it("advertises exactly the touching-cell neighborhood used by every clue", () => {
    const expected = { square: 8, triangular: 12, rhombille: 10 } as const;
    for (const id of TOPOLOGY_IDS) {
      const topology = TOPOLOGIES[id];
      for (let y = -3; y <= 3; y += 1) {
        for (let x = -9; x <= 9; x += 1) {
          const neighbors: CellRef[] = [];
          topology.forEachNeighbor(x, y, (neighborX, neighborY) => neighbors.push({ x: neighborX, y: neighborY }));
          expect(neighbors, `${id} ${x},${y}`).toHaveLength(expected[id]);
          expect(new Set(neighbors.map(keyFor)).size).toBe(neighbors.length);
          expect(neighbors).not.toContainEqual({ x, y });

          const polygon = topology.geometry(x, y).vertices;
          for (const neighbor of neighbors) {
            expect(sharedVertices(polygon, topology.geometry(neighbor.x, neighbor.y).vertices)).toBeGreaterThan(0);
            const reverse: CellRef[] = [];
            topology.forEachNeighbor(neighbor.x, neighbor.y, (reverseX, reverseY) =>
              reverse.push({ x: reverseX, y: reverseY }),
            );
            expect(reverse).toContainEqual({ x, y });
          }
        }
      }
    }
  });

  it("maps each polygon edge to one symmetric edge-sharing neighbor", () => {
    for (const id of TOPOLOGY_IDS) {
      const topology = TOPOLOGIES[id];
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -7; x <= 7; x += 1) {
          const polygon = topology.geometry(x, y).vertices;
          const edgeNeighbors = topology.edgeNeighbors(x, y);
          expect(edgeNeighbors).toHaveLength(polygon.length);
          expect(new Set(edgeNeighbors.map(keyFor)).size).toBe(edgeNeighbors.length);
          for (const neighbor of edgeNeighbors) {
            expect(sharedVertices(polygon, topology.geometry(neighbor.x, neighbor.y).vertices)).toBe(2);
            expect(topology.edgeNeighbors(neighbor.x, neighbor.y)).toContainEqual({ x, y });
          }
        }
      }
    }
  });

  it("round-trips centers through hit testing across negative coordinates", () => {
    for (const id of TOPOLOGY_IDS) {
      const topology = TOPOLOGIES[id];
      for (let y = -5; y <= 5; y += 1) {
        for (let x = -12; x <= 12; x += 1) {
          const center = topology.geometry(x, y).center;
          expect(topology.hitTest(center.x, center.y), `${id} ${x},${y}`).toEqual({ x, y });
        }
      }
    }
  });

  it("returns bounded canonical ranges containing every sampled visible cell", () => {
    const bounds = { minX: -4.25, minY: -3.75, maxX: 5.5, maxY: 4.5 };
    for (const id of TOPOLOGY_IDS) {
      const topology = TOPOLOGIES[id];
      const range = topology.cellRangeForWorldBounds(bounds);
      for (let sampleY = 0; sampleY <= 20; sampleY += 1) {
        for (let sampleX = 0; sampleX <= 20; sampleX += 1) {
          const worldX = bounds.minX + ((bounds.maxX - bounds.minX) * sampleX) / 20;
          const worldY = bounds.minY + ((bounds.maxY - bounds.minY) * sampleY) / 20;
          const cell = topology.hitTest(worldX, worldY);
          expect(cell.x).toBeGreaterThanOrEqual(range.minX);
          expect(cell.x).toBeLessThanOrEqual(range.maxX);
          expect(cell.y).toBeGreaterThanOrEqual(range.minY);
          expect(cell.y).toBeLessThanOrEqual(range.maxY);
        }
      }
    }
  });
});

