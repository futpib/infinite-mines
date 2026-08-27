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
}

export function isOpened(state: CellState): boolean {
  return state >= CellState.Opened && state <= CellState.Opened8;
}

export function openedClue(state: CellState): number {
  return isOpened(state) ? state - CellState.Opened : 0;
}

function openedState(clue: number): CellState {
  return (CellState.Opened + clue) as CellState;
}

export interface ActionResult {
  changed: number;
  scoreDelta: number;
  thingsDelta: number;
  healthDelta: number;
  exploded: boolean;
  autoFlagged: number;
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
const UINT32_RANGE = 0x1_0000_0000;

const EMPTY_RESULT = (): ActionResult => ({
  changed: 0,
  scoreDelta: 0,
  thingsDelta: 0,
  healthDelta: 0,
  exploded: false,
  autoFlagged: 0,
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

  restorePacked(value: unknown): boolean {
    if (!(value instanceof ArrayBuffer) || value.byteLength % CELL_RECORD_BYTES !== 0) return false;

    const nextChunks = new Map<string, StateChunk>();
    const view = new DataView(value);
    let nextNonZeroCells = 0;
    let nextOpenedCells = 0;
    for (let offset = 0; offset < value.byteLength; offset += CELL_RECORD_BYTES) {
      const x = view.getInt32(offset, true);
      const y = view.getInt32(offset + 4, true);
      const state = view.getUint8(offset + 8) as CellState;
      if (state === CellState.Covered || state > CellState.Exploded) return false;

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
}

export class GameModel {
  readonly store = new CellStore();
  mode: Mode;
  seed: number;
  score = 0;
  things = 0;
  health = 3;
  cheats = 0;
  started = false;
  bounds: ExploredBounds | null = null;
  private safeX = 0;
  private safeY = 0;

  constructor(options: GameOptions = {}) {
    this.mode = options.mode ?? "beginner";
    this.seed = options.seed ?? 1;
    this.reset(this.mode, this.seed, options.autoStart ?? true);
  }

  get alive(): boolean {
    return this.health > 0;
  }

  get difficulty(): Difficulty {
    return DIFFICULTIES[this.mode];
  }

  get safeOrigin(): Readonly<{ x: number; y: number }> | null {
    return this.started ? { x: this.safeX, y: this.safeY } : null;
  }

  createSnapshot(): GameSnapshotV1 {
    return {
      version: 1,
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
    const snapshot = value as Partial<GameSnapshotV1>;
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
      snapshot.version !== 1 ||
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
      !this.store.restorePacked(snapshot.cells)
    ) {
      return false;
    }

    this.mode = snapshot.mode as Mode;
    this.seed = snapshot.seed;
    this.score = snapshot.score;
    this.things = snapshot.things;
    this.health = snapshot.health;
    this.cheats = snapshot.cheats ?? 0;
    this.started = snapshot.started;
    this.safeX = snapshot.safeX;
    this.safeY = snapshot.safeY;
    this.bounds = snapshot.bounds ? { ...snapshot.bounds } : null;
    return true;
  }

  reset(mode: Mode = this.mode, seed: number = this.seed, autoStart = true): ActionResult {
    this.mode = mode;
    this.seed = seed >>> 0;
    this.score = 0;
    this.things = 0;
    this.health = DIFFICULTIES[mode].startingHealth;
    this.cheats = 0;
    this.started = false;
    this.bounds = null;
    this.store.clear();
    return autoStart ? this.reveal(0, 0) : EMPTY_RESULT();
  }

  cheatDeath(): boolean {
    if (this.alive) return false;
    this.health = 1;
    this.cheats += 1;
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
    if (this.started && Math.abs(x - this.safeX) <= 2 && Math.abs(y - this.safeY) <= 2) return false;
    if (this.artifactAt(x, y)) return false;
    return hash32(x, y, this.seed, 0x51ed270b) / UINT32_RANGE < this.difficulty.density;
  }

  artifactAt(x: number, y: number): boolean {
    const zoneX = floorDiv(x, ARTIFACT_ZONE);
    const zoneY = floorDiv(y, ARTIFACT_ZONE);
    const artifactX = zoneX * ARTIFACT_ZONE + 3 + (hash32(zoneX, zoneY, this.seed, 0x1b56c4e9) % 18);
    const artifactY = zoneY * ARTIFACT_ZONE + 3 + (hash32(zoneX, zoneY, this.seed, 0x72f8a31d) % 18);
    return x === artifactX && y === artifactY;
  }

  clueAt(x: number, y: number): number {
    let mines = 0;
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if ((offsetX !== 0 || offsetY !== 0) && this.mineAt(x + offsetX, y + offsetY)) mines += 1;
      }
    }
    return mines;
  }

  reveal(x: number, y: number): ActionResult {
    if (!this.alive) return EMPTY_RESULT();
    const state = this.store.get(x, y);
    if (state === CellState.Flagged || state === CellState.Exploded) return EMPTY_RESULT();
    if (state === CellState.Question) {
      this.store.set(x, y, CellState.Covered);
      return { ...EMPTY_RESULT(), changed: 1 };
    }
    if (isOpened(state)) return this.chord(x, y);

    if (!this.started) {
      this.started = true;
      this.safeX = x;
      this.safeY = y;
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
    return { ...EMPTY_RESULT(), changed: 1 };
  }

  private chord(x: number, y: number): ActionResult {
    const plan = this.createChordPlan(x, y);
    if (plan.kind === "reveal") return this.openCascade(plan.cells.flat());
    if (plan.kind === "flag") {
      for (const [neighborX, neighborY] of plan.cells) this.store.set(neighborX, neighborY, CellState.Flagged);
      return { ...EMPTY_RESULT(), changed: plan.cells.length, autoFlagged: plan.cells.length };
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
    while (head < tail) {
      const x = queue[head++];
      const y = queue[head++];

      if (this.mineAt(x, y)) {
        this.store.set(x, y, CellState.Exploded);
        this.extendBounds(x, y);
        exploded = true;
        changed += 1;
        this.forEachNeighbor(x, y, enqueue);
        continue;
      }

      const clue = this.clueAt(x, y);
      this.store.set(x, y, openedState(clue));
      this.extendBounds(x, y);
      changed += 1;
      scoreDelta += clue;
      if (this.artifactAt(x, y)) thingsDelta += 1;
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
    };
  }

  private forEachNeighbor(x: number, y: number, visitor: (neighborX: number, neighborY: number) => void): void {
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX !== 0 || offsetY !== 0) visitor(x + offsetX, y + offsetY);
      }
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
