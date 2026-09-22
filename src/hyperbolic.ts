import {
  Anchor,
  Isom,
  RegularTiling,
  type RegularAddress,
} from "hyperbolic-map";

import type { CellRef, WorldPoint } from "./topology";

export interface HyperbolicCellRecord {
  x: number;
  y: number;
  path: number[];
}

export interface HyperbolicTopologySnapshot {
  version: 1;
  cells: HyperbolicCellRecord[];
}

export interface HyperbolicCellEntry extends CellRef {
  readonly address: RegularAddress;
  readonly id: string;
  readonly path: readonly number[];
}

export interface HyperbolicLocatedCell {
  entry: HyperbolicCellEntry;
  local: readonly [number, number];
  relativeFrame: Isom;
}

const ROOT_KEY = "0,0";
const cellKey = (x: number, y: number): string => `${x},${y}`;

// Two independent 32-bit FNV-1a streams turn the exact Coxeter address into
// the signed integer pair used by the existing sparse game store. A 64-bit
// collision is rejected rather than silently aliasing two pentagons.
const refForId = (id: string): CellRef => {
  let x = 0x811c9dc5;
  let y = 0x9e3779b9;
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    x = Math.imul(x ^ code, 0x01000193);
    y = Math.imul(y ^ code, 0x85ebca77);
    y ^= y >>> 13;
  }
  return { x: x | 0, y: y | 0 };
};

const validPath = (value: unknown, generatorCount: number): value is number[] =>
  Array.isArray(value) &&
  value.length <= 16_384 &&
  value.every((step) => Number.isInteger(step) && step >= 0 && step < generatorCount);

export class HyperbolicTopologyRegistry {
  readonly tiling = new RegularTiling({ p: 5, q: 4 });
  readonly boundary = this.tiling.boundaryLocal().points;

  private readonly byRef = new Map<string, HyperbolicCellEntry>();
  private readonly byId = new Map<string, HyperbolicCellEntry>();
  private readonly touchingCache = new Map<string, readonly HyperbolicCellEntry[]>();
  private readonly edgeCache = new Map<string, readonly HyperbolicCellEntry[]>();
  private readonly edgeStepCache = new Map<
    string,
    readonly { entry: HyperbolicCellEntry; generator: number; frame: Isom }[]
  >();
  private generatorForEdge: readonly number[] | null = null;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.byRef.clear();
    this.byId.clear();
    this.touchingCache.clear();
    this.edgeCache.clear();
    this.edgeStepCache.clear();
    this.register(this.tiling.originAddress(), []);
  }

  get origin(): HyperbolicCellEntry {
    const entry = this.byRef.get(ROOT_KEY);
    if (!entry) throw new Error("Hyperbolic origin is unavailable");
    return entry;
  }

  entryAt(x: number, y: number): HyperbolicCellEntry | null {
    return this.byRef.get(cellKey(x, y)) ?? null;
  }

  entryForId(id: string): HyperbolicCellEntry | null {
    return this.byId.get(id) ?? null;
  }

  addressForPath(path: readonly number[]): RegularAddress {
    let address = this.tiling.originAddress();
    for (const generator of path) address = this.tiling.extendAddress(address, generator);
    return address;
  }

  register(address: RegularAddress, path: readonly number[]): HyperbolicCellEntry {
    const id = this.tiling.addressToString(address);
    const existing = this.byId.get(id);
    if (existing) return existing;

    const ref = this.tiling.addressEquals(address, this.tiling.originAddress()) ? { x: 0, y: 0 } : refForId(id);
    const key = cellKey(ref.x, ref.y);
    const collision = this.byRef.get(key);
    if (collision && collision.id !== id) {
      throw new Error(`Hyperbolic cell-id collision at ${key}`);
    }
    const entry: HyperbolicCellEntry = {
      ...ref,
      address,
      id,
      path: [...path],
    };
    this.byRef.set(key, entry);
    this.byId.set(id, entry);
    return entry;
  }

  entryForPath(path: readonly number[]): HyperbolicCellEntry {
    return this.register(this.addressForPath(path), path);
  }

  edgeNeighbors(x: number, y: number): readonly HyperbolicCellEntry[] {
    const entry = this.requireEntry(x, y);
    const cached = this.edgeCache.get(entry.id);
    if (cached) return cached;
    const neighbors = this.edgeSteps(entry).map((neighbor) => neighbor.entry);
    if (neighbors.length !== 5) throw new Error(`Expected five edge-neighbors, received ${neighbors.length}`);
    this.edgeCache.set(entry.id, neighbors);
    return neighbors;
  }

  touchingNeighbors(x: number, y: number): readonly HyperbolicCellEntry[] {
    const entry = this.requireEntry(x, y);
    const cached = this.touchingCache.get(entry.id);
    if (cached) return cached;
    const edgeSteps = this.edgeSteps(entry);
    const edges = edgeSteps.map((step) => step.entry);
    const touching: HyperbolicCellEntry[] = [];
    for (let edge = 0; edge < edges.length; edge += 1) {
      const first = edges[edge];
      touching.push(first);
      const target = this.boundary[(edge + 1) % this.boundary.length];
      const targetDisk = Isom.identity().applyToLocal(target[0], target[1], undefined, [0, 0]);
      const firstFrame = edgeSteps[edge].frame;
      let oppositeGenerator = -1;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const generator of this.tiling.neighborGens()) {
        const candidate = firstFrame.mul(this.tiling.generator(generator)).applyToDisk(0, 0, [0, 0]);
        if (Math.hypot(candidate[0], candidate[1]) < 1e-8) continue;
        const distance = Math.hypot(candidate[0] - targetDisk[0], candidate[1] - targetDisk[1]);
        if (distance < closestDistance) {
          closestDistance = distance;
          oppositeGenerator = generator;
        }
      }
      if (oppositeGenerator < 0) throw new Error("Unable to resolve a right-angled pentagon vertex-neighbor");
      const oppositeAddress = this.tiling.extendAddress(first.address, oppositeGenerator);
      touching.push(this.register(oppositeAddress, [...first.path, oppositeGenerator]));
    }
    if (new Set(touching.map((neighbor) => neighbor.id)).size !== 10) {
      throw new Error("A {5,4} pentagon must have ten distinct touching neighbors");
    }
    this.touchingCache.set(entry.id, touching);
    return touching;
  }

  geometry(x: number, y: number): { center: WorldPoint; vertices: WorldPoint[] } {
    const entry = this.requireEntry(x, y);
    let frame = Isom.identity();
    let address = this.tiling.originAddress();
    for (const generator of entry.path) {
      frame = frame.mul(this.tiling.stepFrame(address, generator));
      address = this.tiling.extendAddress(address, generator);
    }
    const centerBuffer = frame.applyToDisk(0, 0, [0, 0]);
    const vertices = this.boundary.map(([pointX, pointY]) => {
      const projected = frame.applyToLocal(pointX, pointY, undefined, [0, 0]);
      return { x: projected[0], y: projected[1] };
    });
    return { center: { x: centerBuffer[0], y: centerBuffer[1] }, vertices };
  }

  locateFrom(
    anchorPath: readonly number[],
    cameraLocalX: number,
    cameraLocalY: number,
    maxSteps = 4096,
  ): HyperbolicLocatedCell {
    let address = this.addressForPath(anchorPath);
    let path = [...anchorPath];
    let relativeFrame = Isom.identity();
    let pointX = cameraLocalX;
    let pointY = cameraLocalY;
    let previousDistance = Number.POSITIVE_INFINITY;
    for (let step = 0; step < maxSteps; step += 1) {
      const companion = Math.sqrt(1 + pointX * pointX + pointY * pointY);
      if (!(companion < previousDistance)) break;
      previousDistance = companion;
      const neighbors = this.tiling.neighbors(address);
      const direction = this.tiling.stepToward(pointX, pointY);
      if (direction < 0 || direction >= neighbors.length) break;
      const chosen = neighbors[direction];
      const frame = this.tiling.stepFrame(address, chosen.gen);
      relativeFrame = relativeFrame.mul(frame).normalize();
      address = chosen.address;
      path.push(chosen.gen);
      const localDisk = frame.inverse().applyToLocal(pointX, pointY, companion, [0, 0]);
      const radiusSquared = localDisk[0] * localDisk[0] + localDisk[1] * localDisk[1];
      const scale = 1 / Math.sqrt(Math.max(1e-300, 1 - radiusSquared));
      pointX = localDisk[0] * scale;
      pointY = localDisk[1] * scale;
    }
    return {
      entry: this.register(address, path),
      local: [pointX, pointY],
      relativeFrame,
    };
  }

  hitTestDisk(diskX: number, diskY: number): HyperbolicCellEntry {
    const radiusSquared = diskX * diskX + diskY * diskY;
    const scale = 1 / Math.sqrt(Math.max(1e-300, 1 - Math.min(radiusSquared, 0.999_999_999_999)));
    return this.locateFrom([], diskX * scale, diskY * scale).entry;
  }

  snapshotFor(refs: Iterable<CellRef>): HyperbolicTopologySnapshot {
    const cells = new Map<string, HyperbolicCellRecord>();
    cells.set(ROOT_KEY, { x: 0, y: 0, path: [] });
    for (const ref of refs) {
      const entry = this.requireEntry(ref.x, ref.y);
      cells.set(cellKey(ref.x, ref.y), { x: ref.x, y: ref.y, path: [...entry.path] });
    }
    return { version: 1, cells: [...cells.values()] };
  }

  restore(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Partial<HyperbolicTopologySnapshot>;
    if (snapshot.version !== 1 || !Array.isArray(snapshot.cells) || snapshot.cells.length > 2_000_000) return false;
    const generatorCount = this.tiling.generatorCount();
    const records: HyperbolicCellRecord[] = [];
    for (const valueRecord of snapshot.cells) {
      if (!valueRecord || typeof valueRecord !== "object") return false;
      const record = valueRecord as Partial<HyperbolicCellRecord>;
      if (
        !Number.isInteger(record.x) ||
        !Number.isInteger(record.y) ||
        (record.x as number) < -0x8000_0000 ||
        (record.x as number) > 0x7fff_ffff ||
        (record.y as number) < -0x8000_0000 ||
        (record.y as number) > 0x7fff_ffff ||
        !validPath(record.path, generatorCount)
      ) {
        return false;
      }
      records.push({ x: record.x as number, y: record.y as number, path: record.path });
    }

    try {
      for (const record of records) {
        const address = this.addressForPath(record.path);
        const id = this.tiling.addressToString(address);
        const ref = this.tiling.addressEquals(address, this.tiling.originAddress()) ? { x: 0, y: 0 } : refForId(id);
        if (ref.x !== record.x || ref.y !== record.y) return false;
      }
      for (const record of records) {
        this.entryForPath(record.path);
      }
    } catch {
      return false;
    }
    return true;
  }

  createAnchor(path: readonly number[] = []): Anchor<RegularAddress> {
    return new Anchor(this.tiling, { address: this.addressForPath(path) });
  }

  private requireEntry(x: number, y: number): HyperbolicCellEntry {
    const entry = this.entryAt(x, y);
    if (!entry) throw new RangeError(`Unknown hyperbolic cell (${x}, ${y})`);
    return entry;
  }

  private edgeSteps(
    entry: HyperbolicCellEntry,
  ): readonly { entry: HyperbolicCellEntry; generator: number; frame: Isom }[] {
    const cached = this.edgeStepCache.get(entry.id);
    if (cached) return cached;
    if (!this.generatorForEdge) {
      const edgeAngles = this.boundary.map((point, edge) => {
        const next = this.boundary[(edge + 1) % this.boundary.length];
        const midpoint = Isom.identity().applyToLocal(
          (point[0] + next[0]) / 2,
          (point[1] + next[1]) / 2,
          undefined,
          [0, 0],
        );
        return Math.atan2(midpoint[1], midpoint[0]);
      });
      const assignments = Array<number>(this.boundary.length).fill(-1);
      for (const generator of this.tiling.neighborGens()) {
        const center = this.tiling.generator(generator).applyToDisk(0, 0, [0, 0]);
        const angle = Math.atan2(center[1], center[0]);
        let bestEdge = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let edge = 0; edge < edgeAngles.length; edge += 1) {
          const distance = Math.abs(Math.atan2(Math.sin(angle - edgeAngles[edge]), Math.cos(angle - edgeAngles[edge])));
          if (distance < bestDistance) {
            bestDistance = distance;
            bestEdge = edge;
          }
        }
        assignments[bestEdge] = generator;
      }
      if (assignments.some((generator) => generator < 0)) throw new Error("Pentagon edge generators are incomplete");
      this.generatorForEdge = assignments;
    }
    const steps = this.generatorForEdge.map((generator) => {
      const address = this.tiling.extendAddress(entry.address, generator);
      return {
        entry: this.register(address, [...entry.path, generator]),
        generator,
        frame: this.tiling.stepFrame(entry.address, generator),
      };
    });
    this.edgeStepCache.set(entry.id, steps);
    return steps;
  }
}

export const hyperbolicTopologyRegistry = new HyperbolicTopologyRegistry();
