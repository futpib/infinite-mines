import { describe, expect, it } from "vitest";
import { Arc, geodesicArc } from "hyperbolic-map";
import { TOPOLOGIES, TOPOLOGY_IDS, type CellRef, type WorldPoint } from "../src/topology";
import { hyperbolicTopologyRegistry } from "../src/hyperbolic";

const EUCLIDEAN_TOPOLOGY_IDS = TOPOLOGY_IDS.filter((id) => id !== "pentagonal");

const samePoint = (left: WorldPoint, right: WorldPoint): boolean =>
  Math.hypot(left.x - right.x, left.y - right.y) < 1e-7;

const sharedVertices = (left: readonly WorldPoint[], right: readonly WorldPoint[]): number =>
  left.filter((point) => right.some((candidate) => samePoint(point, candidate))).length;

const keyFor = (cell: CellRef): string => `${cell.x},${cell.y}`;

describe("topology descriptors", () => {
  it("advertises exactly the touching-cell neighborhood used by every clue", () => {
    const expected = { square: 8, hexagonal: 6, triangular: 12, rhombille: 10 } as const;
    for (const id of EUCLIDEAN_TOPOLOGY_IDS) {
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
    for (const id of EUCLIDEAN_TOPOLOGY_IDS) {
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
    for (const id of EUCLIDEAN_TOPOLOGY_IDS) {
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
    for (const id of EUCLIDEAN_TOPOLOGY_IDS) {
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

  it("defines the regular {5,4} graph as five edge and five vertex-only neighbors", () => {
    const topology = TOPOLOGIES.pentagonal;
    const samples: CellRef[] = [{ x: 0, y: 0 }];
    topology.forEachNeighbor(0, 0, (x, y) => samples.push({ x, y }));
    for (const cell of samples) {
      const touching: CellRef[] = [];
      topology.forEachNeighbor(cell.x, cell.y, (x, y) => touching.push({ x, y }));
      const edges = topology.edgeNeighbors(cell.x, cell.y);
      expect(touching).toHaveLength(10);
      expect(edges).toHaveLength(5);
      expect(new Set(touching.map(keyFor)).size).toBe(10);
      expect(new Set(edges.map(keyFor)).size).toBe(5);
      for (const neighbor of touching) {
        const reverse: CellRef[] = [];
        topology.forEachNeighbor(neighbor.x, neighbor.y, (x, y) => reverse.push({ x, y }));
        expect(reverse).toContainEqual(cell);
      }
      for (const neighbor of edges) expect(topology.edgeNeighbors(neighbor.x, neighbor.y)).toContainEqual(cell);
      const center = topology.geometry(cell.x, cell.y).center;
      expect(topology.hitTest(center.x, center.y)).toEqual(cell);
    }
  });

  it("measures every Poincare pentagon corner at 90 degrees", () => {
    const vertices = hyperbolicTopologyRegistry.tiling.vertexDisk;
    for (let index = 0; index < vertices.length; index += 1) {
      const vertex = vertices[index];
      const previous = vertices[(index + vertices.length - 1) % vertices.length];
      const next = vertices[(index + 1) % vertices.length];
      const incoming = geodesicArc(previous[0], previous[1], vertex[0], vertex[1], new Arc(), 0);
      const outgoing = geodesicArc(vertex[0], vertex[1], next[0], next[1], new Arc(), 0);
      expect(incoming.straight).toBe(false);
      expect(outgoing.straight).toBe(false);
      const incomingTangent = [-(vertex[1] - incoming.cy), vertex[0] - incoming.cx];
      const outgoingTangent = [-(vertex[1] - outgoing.cy), vertex[0] - outgoing.cx];
      const cosine =
        Math.abs(incomingTangent[0] * outgoingTangent[0] + incomingTangent[1] * outgoingTangent[1]) /
        (Math.hypot(...incomingTangent) * Math.hypot(...outgoingTangent));
      expect((Math.acos(cosine) * 180) / Math.PI).toBeCloseTo(90, 10);
    }
  });
});
