import { TOPOLOGIES, isTopologyId, type Topology, type TopologyId } from "./topology";

export const MODES = ["beginner", "master", "ultimate", "impossible", "deathmatch"] as const;
export type Mode = (typeof MODES)[number];

export interface Difficulty {
  density: number;
  startingHealth: number;
  healthEvery: number;
}

export const DIFFICULTIES: Record<Mode, Difficulty> = {
  beginner: { density: 0.18, startingHealth: 3, healthEvery: 25_000 },
  master: { density: 0.22, startingHealth: 3, healthEvery: 5_000 },
  ultimate: { density: 0.27, startingHealth: 3, healthEvery: 1_000 },
  impossible: { density: 0.33, startingHealth: 3, healthEvery: 1_000 },
  deathmatch: { density: 0.33, startingHealth: 1, healthEvery: 1_000_000_000 },
};

export function fibonacciHealth(cheatNumber: number): number {
  if (cheatNumber <= 0) return 0;
  if (!Number.isSafeInteger(cheatNumber)) return Number.MAX_SAFE_INTEGER;
  let previous = 1;
  let current = 1;
  for (let index = 2; index < cheatNumber; index += 1) {
    if (Number.MAX_SAFE_INTEGER - current < previous) return Number.MAX_SAFE_INTEGER;
    const next = previous + current;
    previous = current;
    current = next;
  }
  return current;
}

export enum CellState {
  Covered = 0,
  Opened = 1,
  Opened1 = 2,
  Opened2 = 3,
  Opened3 = 4,
  Opened4 = 5,
  Opened5 = 6,
  Opened6 = 7,
  Opened7 = 8,
  Opened8 = 9,
  Flagged = 10,
  Question = 11,
  Exploded = 12,
  Queued = 13,
  Opened9 = 14,
  Opened10 = 15,
  Opened11 = 16,
  Opened12 = 17,
  Opened13 = 18,
  Opened14 = 19,
  Opened15 = 20,
  Opened16 = 21,
  Opened17 = 22,
  Opened18 = 23,
}

const MAX_PACKED_CLUE = 18;

export function isOpened(state: CellState): boolean {
  return (
    (state >= CellState.Opened && state <= CellState.Opened8) ||
    (state >= CellState.Opened9 && state <= CellState.Opened18)
  );
}

export function openedClue(state: CellState): number {
  if (state >= CellState.Opened && state <= CellState.Opened8) return state - CellState.Opened;
  if (state >= CellState.Opened9 && state <= CellState.Opened18) return state - 5;
  return 0;
}

function openedState(clue: number): CellState {
  if (!Number.isInteger(clue) || clue < 0 || clue > MAX_PACKED_CLUE) {
    throw new RangeError(`Cannot pack clue ${clue}`);
  }
  return (clue <= 8 ? CellState.Opened + clue : clue + 5) as CellState;
}

const isPersistedCellState = (state: number): state is CellState => {
  return (
    isOpened(state as CellState) ||
    state === CellState.Flagged ||
    state === CellState.Question ||
    state === CellState.Exploded
  );
};

const migrateLegacyState = (state: number): CellState | null => {
  return isPersistedCellState(state) && state <= CellState.Exploded ? state : null;
};

export interface ActionResult {
  changed: number;
  scoreDelta: number;
  thingsDelta: number;
  healthDelta: number;
  exploded: boolean;
  autoFlagged: number;
  damage: ExploredBounds | null;
}

export interface ExploredBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GameSnapshotV1 {
  version: 1;
  mode: Mode;
  seed: number;
  score: number;
  things: number;
  health: number;
  cheats?: number;
  started: boolean;
  safeX: number;
  safeY: number;
  bounds: ExploredBounds | null;
  cells: ArrayBuffer;
}

export interface GameSnapshotV2 {
  version: 2;
  topology: TopologyId;
  mode: Mode;
  seed: number;
  score: number;
  things: number;
  health: number;
  cheats?: number;
  started: boolean;
  safeX: number;
  safeY: number;
  bounds: ExploredBounds | null;
  cells: ArrayBuffer;
}

export type GameSnapshot = GameSnapshotV1 | GameSnapshotV2;

interface StateChunk {
  cells: Uint8Array;
  nonZero: number;
}

interface ChordPlan {
  kind: "reveal" | "flag" | "none";
  cells: Array<[number, number]>;
}

const CHUNK_SIZE = 64;
const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;
const CELL_RECORD_BYTES = 9;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
export const STATE_TILE_SIZE = 8;
const ARTIFACT_ZONE = 24;
const ARTIFACT_INTERIOR = 18;
const ARTIFACT_CANDIDATE_LIMIT = 128;
const MAX_ARTIFACT_CACHE_ZONES = 4096;
const UINT32_RANGE = 0x1_0000_0000;

const EMPTY_RESULT = (): ActionResult => ({
  changed: 0,
  scoreDelta: 0,
  thingsDelta: 0,
  healthDelta: 0,
  exploded: false,
  autoFlagged: 0,
  damage: null,
});

export function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

export function hash32(x: number, y: number, seed: number, salt = 0): number {
  let value = (seed ^ salt ^ Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77)) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

export class CellStore {
  private readonly chunks = new Map<string, StateChunk>();
  private readonly tileVersions = new Map<string, number>();
  nonZeroCells = 0;
  openedCells = 0;
  version = 0;
  generation = 0;

  get chunkCount(): number {
    return this.chunks.size;
  }

  getTileVersion(tileX: number, tileY: number): number {
    return this.tileVersions.get(`${tileX},${tileY}`) ?? 0;
  }

  get(x: number, y: number): CellState {
    const chunkX = floorDiv(x, CHUNK_SIZE);
    const chunkY = floorDiv(y, CHUNK_SIZE);
    const chunk = this.chunks.get(`${chunkX},${chunkY}`);
    if (!chunk) return CellState.Covered;
    return chunk.cells[this.indexFor(x, y, chunkX, chunkY)] as CellState;
  }

  set(x: number, y: number, state: CellState): void {
    const chunkX = floorDiv(x, CHUNK_SIZE);
    const chunkY = floorDiv(y, CHUNK_SIZE);
    const key = `${chunkX},${chunkY}`;
    let chunk = this.chunks.get(key);
    if (!chunk) {
      if (state === CellState.Covered) return;
      chunk = { cells: new Uint8Array(CHUNK_AREA), nonZero: 0 };
      this.chunks.set(key, chunk);
    }

    const index = this.indexFor(x, y, chunkX, chunkY);
    const previous = chunk.cells[index] as CellState;
    if (previous === state) return;
    this.version += 1;
    const tileKey = `${floorDiv(x, STATE_TILE_SIZE)},${floorDiv(y, STATE_TILE_SIZE)}`;
    this.tileVersions.set(tileKey, (this.tileVersions.get(tileKey) ?? 0) + 1);

    if (previous === CellState.Covered) {
      chunk.nonZero += 1;
      this.nonZeroCells += 1;
    }
    if (state === CellState.Covered) {
      chunk.nonZero -= 1;
      this.nonZeroCells -= 1;
    }
    if (isOpened(previous) || previous === CellState.Exploded) this.openedCells -= 1;
    if (isOpened(state) || state === CellState.Exploded) this.openedCells += 1;

    chunk.cells[index] = state;
    if (chunk.nonZero === 0) this.chunks.delete(key);
  }

  clear(): void {
    this.chunks.clear();
    this.tileVersions.clear();
    this.nonZeroCells = 0;
    this.openedCells = 0;
    this.version += 1;
    this.generation += 1;
  }

  pack(): ArrayBuffer {
    const packed = new ArrayBuffer(this.nonZeroCells * CELL_RECORD_BYTES);
    const view = new DataView(packed);
    let offset = 0;
    this.forEachNonZero((x, y, state) => {
      if (x < INT32_MIN || x > INT32_MAX || y < INT32_MIN || y > INT32_MAX) {
        throw new RangeError("Cell coordinates exceed the persistent world range");
      }
      view.setInt32(offset, x, true);
      view.setInt32(offset + 4, y, true);
      view.setUint8(offset + 8, state);
      offset += CELL_RECORD_BYTES;
    });
    if (offset !== packed.byteLength) throw new Error("Cannot persist a cell store during an active reveal");
    return packed;
  }

  restorePacked(value: unknown, legacyV1 = false, maxClue = MAX_PACKED_CLUE): boolean {
    if (!(value instanceof ArrayBuffer) || value.byteLength % CELL_RECORD_BYTES !== 0) return false;

    const nextChunks = new Map<string, StateChunk>();
    const view = new DataView(value);
    let nextNonZeroCells = 0;
    let nextOpenedCells = 0;
    for (let offset = 0; offset < value.byteLength; offset += CELL_RECORD_BYTES) {
      const x = view.getInt32(offset, true);
      const y = view.getInt32(offset + 4, true);
      const encoded = view.getUint8(offset + 8);
      const state = legacyV1 ? migrateLegacyState(encoded) : isPersistedCellState(encoded) ? encoded : null;
      if (state === null) return false;
      if (isOpened(state) && openedClue(state) > maxClue) return false;

      const chunkX = floorDiv(x, CHUNK_SIZE);
      const chunkY = floorDiv(y, CHUNK_SIZE);
      const key = `${chunkX},${chunkY}`;
      let chunk = nextChunks.get(key);
      if (!chunk) {
        chunk = { cells: new Uint8Array(CHUNK_AREA), nonZero: 0 };
        nextChunks.set(key, chunk);
      }
      const index = this.indexFor(x, y, chunkX, chunkY);
      if (chunk.cells[index] !== CellState.Covered) return false;
      chunk.cells[index] = state;
      chunk.nonZero += 1;
      nextNonZeroCells += 1;
      if (isOpened(state) || state === CellState.Exploded) nextOpenedCells += 1;
    }

    this.chunks.clear();
    for (const [key, chunk] of nextChunks) this.chunks.set(key, chunk);
    this.tileVersions.clear();
    this.nonZeroCells = nextNonZeroCells;
    this.openedCells = nextOpenedCells;
    this.version += 1;
    this.generation += 1;
    return true;
  }

  forEachNonZero(visitor: (x: number, y: number, state: CellState) => void): void {
    for (const [key, chunk] of this.chunks) {
      const separator = key.indexOf(",");
      const chunkX = Number(key.slice(0, separator));
      const chunkY = Number(key.slice(separator + 1));
      const originX = chunkX * CHUNK_SIZE;
      const originY = chunkY * CHUNK_SIZE;
      for (let index = 0; index < CHUNK_AREA; index += 1) {
        const state = chunk.cells[index] as CellState;
        if (state === CellState.Covered || state === CellState.Queued) continue;
        const localX = index % CHUNK_SIZE;
        const localY = (index / CHUNK_SIZE) | 0;
        visitor(originX + localX, originY + localY, state);
      }
    }
  }

  forEachNonZeroInBounds(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visitor: (x: number, y: number, state: CellState) => void,
  ): void {
    if (minX > maxX || minY > maxY) return;
    const minChunkX = floorDiv(minX, CHUNK_SIZE);
    const minChunkY = floorDiv(minY, CHUNK_SIZE);
    const maxChunkX = floorDiv(maxX, CHUNK_SIZE);
    const maxChunkY = floorDiv(maxY, CHUNK_SIZE);
    for (let chunkY = minChunkY; chunkY <= maxChunkY; chunkY += 1) {
      for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
        const chunk = this.chunks.get(`${chunkX},${chunkY}`);
        if (!chunk) continue;
        const originX = chunkX * CHUNK_SIZE;
        const originY = chunkY * CHUNK_SIZE;
        const startX = Math.max(0, minX - originX);
        const startY = Math.max(0, minY - originY);
        const endX = Math.min(CHUNK_SIZE - 1, maxX - originX);
        const endY = Math.min(CHUNK_SIZE - 1, maxY - originY);
        for (let localY = startY; localY <= endY; localY += 1) {
          const rowOffset = localY * CHUNK_SIZE;
          for (let localX = startX; localX <= endX; localX += 1) {
            const state = chunk.cells[rowOffset + localX] as CellState;
            if (state === CellState.Covered || state === CellState.Queued) continue;
            visitor(originX + localX, originY + localY, state);
          }
        }
      }
    }
  }

  private indexFor(x: number, y: number, chunkX: number, chunkY: number): number {
    return (y - chunkY * CHUNK_SIZE) * CHUNK_SIZE + (x - chunkX * CHUNK_SIZE);
  }
}

export interface GameOptions {
  mode?: Mode;
  seed?: number;
  autoStart?: boolean;
  topology?: TopologyId;
}

export class GameModel {
  readonly store = new CellStore();
  mode: Mode;
  seed: number;
  topologyId: TopologyId;
  score = 0;
  things = 0;
  health = 3;
  cheats = 0;
  started = false;
  bounds: ExploredBounds | null = null;
  private safeX = 0;
  private safeY = 0;
  private readonly safeCells = new Set<string>();
  private readonly artifactCache = new Map<string, Readonly<{ x: number; y: number }> | null>();

  constructor(options: GameOptions = {}) {
    this.mode = options.mode ?? "beginner";
    this.seed = options.seed ?? 1;
    this.topologyId = options.topology ?? "square";
    this.reset(this.mode, this.seed, options.autoStart ?? true, this.topologyId);
  }

  get alive(): boolean {
    return this.health > 0;
  }

  get difficulty(): Difficulty {
    return DIFFICULTIES[this.mode];
  }

  get topology(): Topology {
    return TOPOLOGIES[this.topologyId];
  }

  get safeOrigin(): Readonly<{ x: number; y: number }> | null {
    return this.started ? { x: this.safeX, y: this.safeY } : null;
  }

  get nextCheatDeathHealth(): number {
    return fibonacciHealth(this.cheats + 1);
  }

  createSnapshot(): GameSnapshotV2 {
    return {
      version: 2,
      topology: this.topologyId,
      mode: this.mode,
      seed: this.seed,
      score: this.score,
      things: this.things,
      health: this.health,
      cheats: this.cheats,
      started: this.started,
      safeX: this.safeX,
      safeY: this.safeY,
      bounds: this.bounds ? { ...this.bounds } : null,
      cells: this.store.pack(),
    };
  }

  restoreSnapshot(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Partial<GameSnapshot>;
    const restoredTopology: TopologyId = snapshot.version === 2 && isTopologyId(snapshot.topology) ? snapshot.topology : "square";
    const validUnsignedInteger = (candidate: unknown): candidate is number =>
      Number.isSafeInteger(candidate) && (candidate as number) >= 0;
    const validCoordinate = (candidate: unknown): candidate is number =>
      Number.isInteger(candidate) && (candidate as number) >= INT32_MIN && (candidate as number) <= INT32_MAX;
    const validBounds = (candidate: unknown): candidate is ExploredBounds => {
      if (!candidate || typeof candidate !== "object") return false;
      const bounds = candidate as Partial<ExploredBounds>;
      return (
        validCoordinate(bounds.minX) &&
        validCoordinate(bounds.minY) &&
        validCoordinate(bounds.maxX) &&
        validCoordinate(bounds.maxY) &&
        bounds.minX <= bounds.maxX &&
        bounds.minY <= bounds.maxY
      );
    };

    if (
      (snapshot.version !== 1 && snapshot.version !== 2) ||
      (snapshot.version === 2 && !isTopologyId(snapshot.topology)) ||
      !MODES.includes(snapshot.mode as Mode) ||
      !validUnsignedInteger(snapshot.seed) ||
      snapshot.seed > 0xffff_ffff ||
      !validUnsignedInteger(snapshot.score) ||
      !validUnsignedInteger(snapshot.things) ||
      !validUnsignedInteger(snapshot.health) ||
      (snapshot.cheats !== undefined && !validUnsignedInteger(snapshot.cheats)) ||
      typeof snapshot.started !== "boolean" ||
      !validCoordinate(snapshot.safeX) ||
      !validCoordinate(snapshot.safeY) ||
      (snapshot.bounds !== null && !validBounds(snapshot.bounds)) ||
      !this.store.restorePacked(snapshot.cells, snapshot.version === 1, TOPOLOGIES[restoredTopology].maxNeighbors)
    ) {
      return false;
    }

    this.mode = snapshot.mode as Mode;
    this.seed = snapshot.seed;
    this.topologyId = restoredTopology;
    this.score = snapshot.score;
    this.things = snapshot.things;
    this.health = snapshot.health;
    this.cheats = snapshot.cheats ?? 0;
    this.started = snapshot.started;
    this.safeX = snapshot.safeX;
    this.safeY = snapshot.safeY;
    this.bounds = snapshot.bounds ? { ...snapshot.bounds } : null;
    this.safeCells.clear();
    if (this.started) this.buildSafeRegion(this.safeX, this.safeY);
    this.artifactCache.clear();
    const staleArtifactClues: Array<[number, number]> = [];
    this.store.forEachNonZero((x, y, state) => {
      if (isOpened(state) && openedClue(state) !== 0 && this.artifactAt(x, y)) {
        staleArtifactClues.push([x, y]);
      }
    });
    for (const [x, y] of staleArtifactClues) this.store.set(x, y, CellState.Opened);
    return true;
  }

  reset(
    mode: Mode = this.mode,
    seed: number = this.seed,
    autoStart = true,
    topology: TopologyId = this.topologyId,
  ): ActionResult {
    this.mode = mode;
    this.seed = seed >>> 0;
    this.topologyId = topology;
    this.score = 0;
    this.things = 0;
    this.health = DIFFICULTIES[mode].startingHealth;
    this.cheats = 0;
    this.started = false;
    this.bounds = null;
    this.safeCells.clear();
    this.artifactCache.clear();
    this.store.clear();
    return autoStart ? this.reveal(0, 0) : EMPTY_RESULT();
  }

  cheatDeath(): boolean {
    if (this.alive) return false;
    this.health = this.nextCheatDeathHealth;
    this.cheats = Math.min(Number.MAX_SAFE_INTEGER, this.cheats + 1);
    return true;
  }

  getState(x: number, y: number): CellState {
    return this.store.get(x, y);
  }

  previewClickCells(x: number, y: number): Array<{ x: number; y: number }> {
    const center = { x, y };
    if (!isOpened(this.store.get(x, y))) return [center];
    const plan = this.createChordPlan(x, y);
    return plan.kind === "none" ? [center] : [center, ...plan.cells.map(([cellX, cellY]) => ({ x: cellX, y: cellY }))];
  }

  mineAt(x: number, y: number): boolean {
    if (this.started && this.safeCells.has(`${x},${y}`)) return false;
    if (this.artifactAt(x, y)) return false;
    return this.rawMineAt(x, y);
  }

  artifactAt(x: number, y: number): boolean {
    const zoneX = floorDiv(x, ARTIFACT_ZONE);
    const zoneY = floorDiv(y, ARTIFACT_ZONE);
    const artifact = this.artifactForZone(zoneX, zoneY);
    return artifact !== null && x === artifact.x && y === artifact.y;
  }

  private rawMineAt(x: number, y: number): boolean {
    const topologySalt = this.topologyId === "square" ? 0 : this.topologyId === "triangular" ? 0x34c1a5d7 : 0x69b284eb;
    return hash32(x, y, this.seed, 0x51ed270b ^ topologySalt) / UINT32_RANGE < this.difficulty.density;
  }

  private artifactForZone(zoneX: number, zoneY: number): Readonly<{ x: number; y: number }> | null {
    const key = `${zoneX},${zoneY}`;
    if (this.artifactCache.has(key)) {
      return this.artifactCache.get(key) ?? null;
    }

    const candidateCount = ARTIFACT_INTERIOR * ARTIFACT_INTERIOR;
    const start = hash32(zoneX, zoneY, this.seed, 0x1b56c4e9) % candidateCount;
    let artifact: Readonly<{ x: number; y: number }> | null = null;
    for (let attempt = 0; attempt < ARTIFACT_CANDIDATE_LIMIT; attempt += 1) {
      const candidate = (start + attempt) % candidateCount;
      const candidateX = zoneX * ARTIFACT_ZONE + 3 + (candidate % ARTIFACT_INTERIOR);
      const candidateY = zoneY * ARTIFACT_ZONE + 3 + Math.floor(candidate / ARTIFACT_INTERIOR);
      if (this.rawMineAt(candidateX, candidateY)) continue;
      let zero = true;
      this.topology.forEachNeighbor(candidateX, candidateY, (neighborX, neighborY) => {
        if (zero && this.rawMineAt(neighborX, neighborY)) zero = false;
      });
      if (zero) {
        artifact = { x: candidateX, y: candidateY };
        break;
      }
    }
    this.artifactCache.set(key, artifact);
    while (this.artifactCache.size > MAX_ARTIFACT_CACHE_ZONES) {
      const oldest = this.artifactCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.artifactCache.delete(oldest);
    }
    return artifact;
  }

  clueAt(x: number, y: number): number {
    let mines = 0;
    this.topology.forEachNeighbor(x, y, (neighborX, neighborY) => {
      if (this.mineAt(neighborX, neighborY)) mines += 1;
    });
    return mines;
  }

  reveal(x: number, y: number): ActionResult {
    if (!this.alive) return EMPTY_RESULT();
    const state = this.store.get(x, y);
    if (state === CellState.Flagged || state === CellState.Exploded) return EMPTY_RESULT();
    if (state === CellState.Question) {
      this.store.set(x, y, CellState.Covered);
      return { ...EMPTY_RESULT(), changed: 1, damage: { minX: x, minY: y, maxX: x, maxY: y } };
    }
    if (isOpened(state)) return this.chord(x, y);

    if (!this.started) {
      this.started = true;
      this.safeX = x;
      this.safeY = y;
      this.buildSafeRegion(x, y);
    }
    return this.openCascade([x, y]);
  }

  cycleMark(x: number, y: number): ActionResult {
    if (!this.alive) return EMPTY_RESULT();
    const state = this.store.get(x, y);
    if (isOpened(state) || state === CellState.Exploded || state === CellState.Queued) {
      return EMPTY_RESULT();
    }
    const next =
      state === CellState.Covered
        ? CellState.Flagged
        : state === CellState.Flagged
          ? CellState.Question
          : CellState.Covered;
    this.store.set(x, y, next);
    return { ...EMPTY_RESULT(), changed: 1, damage: { minX: x, minY: y, maxX: x, maxY: y } };
  }

  private chord(x: number, y: number): ActionResult {
    const plan = this.createChordPlan(x, y);
    if (plan.kind === "reveal") return this.openCascade(plan.cells.flat());
    if (plan.kind === "flag") {
      for (const [neighborX, neighborY] of plan.cells) this.store.set(neighborX, neighborY, CellState.Flagged);
      return {
        ...EMPTY_RESULT(),
        changed: plan.cells.length,
        autoFlagged: plan.cells.length,
        damage: this.boundsForCells(plan.cells),
      };
    }
    return EMPTY_RESULT();
  }

  private createChordPlan(x: number, y: number): ChordPlan {
    const clue = openedClue(this.store.get(x, y));
    const closed: Array<[number, number]> = [];
    let flags = 0;
    let explodedMines = 0;

    this.forEachNeighbor(x, y, (neighborX, neighborY) => {
      const state = this.store.get(neighborX, neighborY);
      if (state === CellState.Flagged) flags += 1;
      if (state === CellState.Exploded && this.mineAt(neighborX, neighborY)) explodedMines += 1;
      if (!isOpened(state) && state !== CellState.Exploded) closed.push([neighborX, neighborY]);
    });

    if (flags + explodedMines === clue) {
      return {
        kind: "reveal",
        cells: closed.filter(([neighborX, neighborY]) => this.store.get(neighborX, neighborY) !== CellState.Flagged),
      };
    }

    if (closed.length + explodedMines === clue) {
      return {
        kind: "flag",
        cells: closed.filter(([neighborX, neighborY]) => this.store.get(neighborX, neighborY) !== CellState.Flagged),
      };
    }

    return { kind: "none", cells: [] };
  }

  private openCascade(initial: number[]): ActionResult {
    if (initial.length === 0) return EMPTY_RESULT();

    let queue = new Int32Array(Math.max(128, initial.length * 2));
    let head = 0;
    let tail = 0;
    const enqueue = (x: number, y: number): void => {
      const state = this.store.get(x, y);
      if (
        isOpened(state) ||
        state === CellState.Exploded ||
        state === CellState.Flagged ||
        state === CellState.Queued
      ) {
        return;
      }
      this.store.set(x, y, CellState.Queued);
      if (tail + 2 > queue.length) {
        const expanded = new Int32Array(queue.length * 2);
        expanded.set(queue);
        queue = expanded;
      }
      queue[tail++] = x;
      queue[tail++] = y;
    };

    for (let index = 0; index < initial.length; index += 2) enqueue(initial[index], initial[index + 1]);

    let changed = 0;
    let scoreDelta = 0;
    let thingsDelta = 0;
    let exploded = false;
    let damage: ExploredBounds | null = null;
    while (head < tail) {
      const x = queue[head++];
      const y = queue[head++];
      if (damage === null) damage = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        damage.minX = Math.min(damage.minX, x);
        damage.minY = Math.min(damage.minY, y);
        damage.maxX = Math.max(damage.maxX, x);
        damage.maxY = Math.max(damage.maxY, y);
      }

      if (this.mineAt(x, y)) {
        this.store.set(x, y, CellState.Exploded);
        this.extendBounds(x, y);
        exploded = true;
        changed += 1;
        // A blast opens its immediately touching safe cells, but covered mines
        // are barriers. Recursively queueing adjacent mines can walk an
        // unbounded mine component on an infinite high-degree topology and
        // monopolize the main thread forever. Mines explicitly included in the
        // original reveal/chord still detonate because they were queued before
        // the cascade began.
        this.forEachNeighbor(x, y, (neighborX, neighborY) => {
          const neighborState = this.store.get(neighborX, neighborY);
          if (
            isOpened(neighborState) ||
            neighborState === CellState.Exploded ||
            neighborState === CellState.Flagged ||
            neighborState === CellState.Queued ||
            this.mineAt(neighborX, neighborY)
          ) {
            return;
          }
          enqueue(neighborX, neighborY);
        });
        continue;
      }

      const clue = this.clueAt(x, y);
      this.store.set(x, y, openedState(clue));
      this.extendBounds(x, y);
      changed += 1;
      scoreDelta += clue;
      if (clue === 0 && this.artifactAt(x, y)) thingsDelta += 1;
      if (clue === 0) this.forEachNeighbor(x, y, enqueue);
    }

    const previousHealth = this.health;
    const previousTier = Math.floor(this.score / this.difficulty.healthEvery);
    this.score += scoreDelta;
    this.things += thingsDelta;
    if (exploded) this.health -= 1;
    this.health += Math.floor(this.score / this.difficulty.healthEvery) - previousTier;

    return {
      changed,
      scoreDelta,
      thingsDelta,
      healthDelta: this.health - previousHealth,
      exploded,
      autoFlagged: 0,
      damage,
    };
  }

  private boundsForCells(cells: ReadonlyArray<readonly [number, number]>): ExploredBounds | null {
    if (cells.length === 0) return null;
    const bounds: ExploredBounds = {
      minX: cells[0][0],
      minY: cells[0][1],
      maxX: cells[0][0],
      maxY: cells[0][1],
    };
    for (let index = 1; index < cells.length; index += 1) {
      const [x, y] = cells[index];
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
    return bounds;
  }

  private forEachNeighbor(x: number, y: number, visitor: (neighborX: number, neighborY: number) => void): void {
    this.topology.forEachNeighbor(x, y, visitor);
  }

  private buildSafeRegion(originX: number, originY: number): void {
    this.safeCells.clear();
    let frontier: Array<[number, number]> = [[originX, originY]];
    this.safeCells.add(`${originX},${originY}`);
    for (let distance = 0; distance < 2; distance += 1) {
      const next: Array<[number, number]> = [];
      for (const [x, y] of frontier) {
        this.topology.forEachNeighbor(x, y, (neighborX, neighborY) => {
          const key = `${neighborX},${neighborY}`;
          if (this.safeCells.has(key)) return;
          this.safeCells.add(key);
          next.push([neighborX, neighborY]);
        });
      }
      frontier = next;
    }
  }

  private extendBounds(x: number, y: number): void {
    if (!this.bounds) {
      this.bounds = { minX: x, minY: y, maxX: x, maxY: y };
      return;
    }
    if (x < this.bounds.minX) this.bounds.minX = x;
    if (x > this.bounds.maxX) this.bounds.maxX = x;
    if (y < this.bounds.minY) this.bounds.minY = y;
    if (y > this.bounds.maxY) this.bounds.maxY = y;
  }
}
