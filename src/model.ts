import { TOPOLOGIES, isTopologyId, type CellRef, type Topology, type TopologyId } from "./topology";
import { hyperbolicTopologyRegistry, type HyperbolicTopologySnapshot } from "./hyperbolic";
import { thingAlphaOffsets } from "./thing-alpha-footprints";
import { THING_CATALOG_COUNT, THING_CURATED_COUNT } from "./thing-catalog-meta";

export const PRESET_MODES = ["beginner", "master", "ultimate", "impossible", "deathmatch"] as const;
export const MODES = [...PRESET_MODES, "custom"] as const;
export type Mode = (typeof MODES)[number];
export type PresetMode = (typeof PRESET_MODES)[number];

export interface Difficulty {
  density: number;
  startingHealth: number;
  healthEvery: number;
}

export const PRESET_DENSITIES: Record<PresetMode, number> = {
  beginner: 0.18,
  master: 0.22,
  ultimate: 0.27,
  impossible: 0.33,
  deathmatch: 0.33,
};

export const CUSTOM_DENSITY_MIN = 0.12;
export const CUSTOM_DENSITY_MAX = 0.5;
export const CUSTOM_DENSITY_DEFAULT = 0.25;

export const isValidDensity = (density: unknown): density is number =>
  typeof density === "number" &&
  Number.isFinite(density) &&
  density >= CUSTOM_DENSITY_MIN &&
  density <= CUSTOM_DENSITY_MAX;

export const DIFFICULTIES: Record<Mode, Difficulty> = {
  beginner: {
    density: PRESET_DENSITIES.beginner,
    startingHealth: 3,
    healthEvery: 25_000,
  },
  master: {
    density: PRESET_DENSITIES.master,
    startingHealth: 3,
    healthEvery: 5_000,
  },
  ultimate: {
    density: PRESET_DENSITIES.ultimate,
    startingHealth: 3,
    healthEvery: 1_000,
  },
  impossible: {
    density: PRESET_DENSITIES.impossible,
    startingHealth: 3,
    healthEvery: 1_000,
  },
  deathmatch: {
    density: PRESET_DENSITIES.deathmatch,
    startingHealth: 1,
    healthEvery: 1_000_000_000,
  },
  custom: { density: CUSTOM_DENSITY_DEFAULT, startingHealth: 3, healthEvery: 25_000 },
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

export interface GameSnapshot {
  version: 1;
  topology: TopologyId;
  mode: Mode;
  density: number;
  thingsEnabled: boolean;
  seed: number;
  score: number;
  things: number;
  health: number;
  cheats: number;
  started: boolean;
  safeX: number;
  safeY: number;
  bounds: ExploredBounds | null;
  cells: ArrayBuffer;
  hyperbolic?: HyperbolicTopologySnapshot;
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
export const THING_ZONE_SIZE = 24;
export const THING_SMALL_RESERVED_SIDE = 5;
export const THING_LARGE_RESERVED_SIDE = 6;
export const THING_SMALL_PROBABILITY = 5 / 6;
export const THING_SPRITE_COUNT = THING_CATALOG_COUNT;
export const THING_SPRITE_SALT = 0x2d947f31;
const THING_CURATED_PERMUTATION_MULTIPLIERS = [1, 5, 7, 11] as const;
export const MAX_CHAIN_EXPLOSIONS_PER_ACTION = 256;
export const thingReservedSideForRoll = (
  roll: number,
): typeof THING_SMALL_RESERVED_SIDE | typeof THING_LARGE_RESERVED_SIDE =>
  roll < THING_SMALL_PROBABILITY ? THING_SMALL_RESERVED_SIDE : THING_LARGE_RESERVED_SIDE;
const MAX_THING_CACHE_ZONES = 4096;
const UINT32_RANGE = 0x1_0000_0000;
const THING_SPATIAL_TEMPLATE_CACHE = new Map<string, readonly { x: number; y: number }[]>();

interface ThingLayout {
  readonly x: number;
  readonly y: number;
  readonly spriteSide: number;
  readonly reserved: Uint32Array;
  readonly visual: Uint32Array;
  readonly art: Uint32Array;
}

export interface ThingVisual {
  /** The collectible/discovery cell. */
  readonly x: number;
  readonly y: number;
  /** Topology cells defining the intended inner artwork footprint. */
  readonly cells: readonly { x: number; y: number }[];
  /** Cells intersected by non-transparent artwork. */
  readonly artCells: readonly { x: number; y: number }[];
  /** Complete mine-free reservation available to carry any artwork overflow. */
  readonly reservedCells: readonly { x: number; y: number }[];
  readonly side: number;
  readonly sprite: number;
}

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

const positiveModulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

const greatestCommonDivisor = (left: number, right: number): number => {
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return Math.abs(left);
};

const coprimeMultiplier = (value: number, modulus: number): number => {
  let candidate = positiveModulo(value, modulus);
  if (candidate === 0) candidate = 1;
  while (greatestCommonDivisor(candidate, modulus) !== 1) candidate = (candidate + 1) % modulus || 1;
  return candidate;
};

/** Return a zone's zero-based position in the square spiral around the field origin, modulo the deck size. */
export const thingDeckPositionForZone = (zoneX: number, zoneY: number): number => {
  const ring = Math.max(Math.abs(zoneX), Math.abs(zoneY));
  if (ring === 0) return 0;
  const ringModulo = ring % THING_SPRITE_COUNT;
  const sideModulo = (2 * ringModulo + 1) % THING_SPRITE_COUNT;
  const ringEnd = positiveModulo(sideModulo * sideModulo - 1, THING_SPRITE_COUNT);
  let distanceFromEnd: number;
  if (zoneY === -ring) distanceFromEnd = ring - zoneX;
  else if (zoneX === -ring) distanceFromEnd = 2 * ring + (zoneY + ring);
  else if (zoneY === ring) distanceFromEnd = 4 * ring + (zoneX + ring);
  else distanceFromEnd = 6 * ring + (ring - zoneY);
  return positiveModulo(ringEnd - (distanceFromEnd % THING_SPRITE_COUNT), THING_SPRITE_COUNT);
};

/**
 * Deal one complete deterministic catalog per outward spiral. The curated deck
 * occupies the first positions; every remaining Noto emoji follows in a
 * seed-permuted order before the catalog can repeat.
 */
export const thingSpriteFor = (x: number, y: number, seed: number): number => {
  const zoneX = floorDiv(x, THING_ZONE_SIZE);
  const zoneY = floorDiv(y, THING_ZONE_SIZE);
  const position = thingDeckPositionForZone(zoneX, zoneY);
  const selector = hash32(0, 0, seed, THING_SPRITE_SALT);
  if (position < THING_CURATED_COUNT) {
    const multiplier = THING_CURATED_PERMUTATION_MULTIPLIERS[selector & 3];
    return (position * multiplier + ((selector >>> 4) % THING_CURATED_COUNT)) % THING_CURATED_COUNT;
  }
  const remaining = THING_SPRITE_COUNT - THING_CURATED_COUNT;
  const multiplier = coprimeMultiplier(selector >>> 1, remaining);
  const offset = hash32(0, 0, seed, THING_SPRITE_SALT ^ 0x6a09e667) % remaining;
  return THING_CURATED_COUNT + positiveModulo((position - THING_CURATED_COUNT) * multiplier + offset, remaining);
};

export class CellStore {
  private readonly chunks = new Map<string, StateChunk>();
  private directCells: Map<string, CellState> | null = null;
  private readonly tileVersions = new Map<string, number>();
  nonZeroCells = 0;
  openedCells = 0;
  version = 0;
  generation = 0;

  get chunkCount(): number {
    return this.directCells?.size ?? this.chunks.size;
  }

  setDirectMode(enabled: boolean): void {
    if ((this.directCells !== null) === enabled) return;
    this.clear();
    this.directCells = enabled ? new Map<string, CellState>() : null;
  }

  getTileVersion(tileX: number, tileY: number): number {
    return this.tileVersions.get(`${tileX},${tileY}`) ?? 0;
  }

  get(x: number, y: number): CellState {
    if (this.directCells) return this.directCells.get(`${x},${y}`) ?? CellState.Covered;
    const chunkX = floorDiv(x, CHUNK_SIZE);
    const chunkY = floorDiv(y, CHUNK_SIZE);
    const chunk = this.chunks.get(`${chunkX},${chunkY}`);
    if (!chunk) return CellState.Covered;
    return chunk.cells[this.indexFor(x, y, chunkX, chunkY)] as CellState;
  }

  set(x: number, y: number, state: CellState): void {
    if (this.directCells) {
      const key = `${x},${y}`;
      const previous = this.directCells.get(key) ?? CellState.Covered;
      if (previous === state) return;
      this.version += 1;
      if (previous === CellState.Covered) this.nonZeroCells += 1;
      if (state === CellState.Covered) this.nonZeroCells -= 1;
      if (isOpened(previous) || previous === CellState.Exploded) this.openedCells -= 1;
      if (isOpened(state) || state === CellState.Exploded) this.openedCells += 1;
      if (state === CellState.Covered) this.directCells.delete(key);
      else this.directCells.set(key, state);
      return;
    }
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
    this.directCells?.clear();
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

  restorePacked(value: unknown, maxClue = MAX_PACKED_CLUE): boolean {
    if (!(value instanceof ArrayBuffer) || value.byteLength % CELL_RECORD_BYTES !== 0) return false;

    const nextChunks = new Map<string, StateChunk>();
    const nextDirect = this.directCells ? new Map<string, CellState>() : null;
    const view = new DataView(value);
    let nextNonZeroCells = 0;
    let nextOpenedCells = 0;
    for (let offset = 0; offset < value.byteLength; offset += CELL_RECORD_BYTES) {
      const x = view.getInt32(offset, true);
      const y = view.getInt32(offset + 4, true);
      const encoded = view.getUint8(offset + 8);
      const state = isPersistedCellState(encoded) ? encoded : null;
      if (state === null) return false;
      if (isOpened(state) && openedClue(state) > maxClue) return false;

      if (nextDirect) {
        const key = `${x},${y}`;
        if (nextDirect.has(key)) return false;
        nextDirect.set(key, state);
        nextNonZeroCells += 1;
        if (isOpened(state) || state === CellState.Exploded) nextOpenedCells += 1;
        continue;
      }

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
    if (this.directCells) {
      this.directCells.clear();
      for (const [key, state] of nextDirect ?? []) this.directCells.set(key, state);
    } else {
      for (const [key, chunk] of nextChunks) this.chunks.set(key, chunk);
    }
    this.tileVersions.clear();
    this.nonZeroCells = nextNonZeroCells;
    this.openedCells = nextOpenedCells;
    this.version += 1;
    this.generation += 1;
    return true;
  }

  forEachNonZero(visitor: (x: number, y: number, state: CellState) => void): void {
    if (this.directCells) {
      for (const [key, state] of this.directCells) {
        const separator = key.indexOf(",");
        visitor(Number(key.slice(0, separator)), Number(key.slice(separator + 1)), state);
      }
      return;
    }
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
    if (this.directCells) {
      this.forEachNonZero((x, y, state) => {
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) visitor(x, y, state);
      });
      return;
    }
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
  density?: number;
  seed?: number;
  autoStart?: boolean;
  topology?: TopologyId;
  thingsEnabled?: boolean;
}

export class GameModel {
  readonly store = new CellStore();
  mode: Mode;
  density: number;
  thingsEnabled: boolean;
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
  private readonly thingCache = new Map<string, ThingLayout>();

  constructor(options: GameOptions = {}) {
    this.mode = options.mode ?? "beginner";
    this.density = DIFFICULTIES[this.mode].density;
    this.seed = options.seed ?? 1;
    this.topologyId = options.topology ?? "square";
    this.thingsEnabled = options.thingsEnabled ?? true;
    this.reset(
      this.mode,
      this.seed,
      options.autoStart ?? true,
      this.topologyId,
      options.density,
      this.thingsEnabled,
    );
  }

  get alive(): boolean {
    return this.health > 0;
  }

  get difficulty(): Difficulty {
    return { ...DIFFICULTIES[this.mode], density: this.density };
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

  get canCheatDeath(): boolean {
    return this.mode !== "deathmatch" && !this.alive;
  }

  createSnapshot(): GameSnapshot {
    const snapshot: GameSnapshot = {
      version: 1,
      topology: this.topologyId,
      mode: this.mode,
      density: this.density,
      thingsEnabled: this.thingsEnabled,
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
    if (this.topologyId === "pentagonal") {
      const refs: CellRef[] = [];
      this.store.forEachNonZero((x, y) => refs.push({ x, y }));
      if (this.started) refs.push({ x: this.safeX, y: this.safeY });
      snapshot.hyperbolic = hyperbolicTopologyRegistry.snapshotFor(refs);
    }
    return snapshot;
  }

  restoreSnapshot(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Partial<GameSnapshot>;
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
      !isTopologyId(snapshot.topology) ||
      !MODES.includes(snapshot.mode as Mode) ||
      !isValidDensity(snapshot.density) ||
      typeof snapshot.thingsEnabled !== "boolean" ||
      (snapshot.topology === "pentagonal" && snapshot.thingsEnabled) ||
      !validUnsignedInteger(snapshot.seed) ||
      snapshot.seed > 0xffff_ffff ||
      !validUnsignedInteger(snapshot.score) ||
      !validUnsignedInteger(snapshot.things) ||
      !validUnsignedInteger(snapshot.health) ||
      !validUnsignedInteger(snapshot.cheats) ||
      typeof snapshot.started !== "boolean" ||
      !validCoordinate(snapshot.safeX) ||
      !validCoordinate(snapshot.safeY) ||
      (snapshot.bounds !== null && !validBounds(snapshot.bounds))
    ) {
      return false;
    }

    if (snapshot.topology === "pentagonal" && !hyperbolicTopologyRegistry.restore(snapshot.hyperbolic)) {
      return false;
    }
    const directMode = snapshot.topology === "pentagonal";
    const candidateStore = new CellStore();
    candidateStore.setDirectMode(directMode);
    if (!candidateStore.restorePacked(snapshot.cells, TOPOLOGIES[snapshot.topology].maxNeighbors)) {
      return false;
    }
    if (snapshot.topology === "pentagonal") {
      let complete = true;
      candidateStore.forEachNonZero((x, y) => {
        if (!hyperbolicTopologyRegistry.entryAt(x, y)) complete = false;
      });
      if (!complete || (snapshot.started && !hyperbolicTopologyRegistry.entryAt(snapshot.safeX, snapshot.safeY))) {
        return false;
      }
    }

    // Validate into an isolated store first so a corrupt cross-topology record
    // cannot clear or change the currently playable field.
    this.store.setDirectMode(directMode);
    if (!this.store.restorePacked(snapshot.cells, TOPOLOGIES[snapshot.topology].maxNeighbors)) return false;

    this.mode = snapshot.mode as Mode;
    this.density = snapshot.density as number;
    this.thingsEnabled = snapshot.topology === "pentagonal" ? false : snapshot.thingsEnabled;
    this.seed = snapshot.seed;
    this.topologyId = snapshot.topology;
    this.score = snapshot.score;
    this.things = snapshot.things;
    this.health = snapshot.health;
    this.cheats = snapshot.cheats;
    this.started = snapshot.started;
    this.safeX = snapshot.safeX;
    this.safeY = snapshot.safeY;
    this.bounds = snapshot.bounds ? { ...snapshot.bounds } : null;
    this.safeCells.clear();
    if (this.started) this.buildSafeRegion(this.safeX, this.safeY);
    this.thingCache.clear();
    return true;
  }

  reset(
    mode: Mode = this.mode,
    seed: number = this.seed,
    autoStart = true,
    topology: TopologyId = this.topologyId,
    density: number = DIFFICULTIES[mode].density,
    thingsEnabled: boolean = this.thingsEnabled,
  ): ActionResult {
    if (!isValidDensity(density)) throw new RangeError(`Density must be between 12% and 50%: ${density}`);
    this.mode = mode;
    this.density = density;
    this.thingsEnabled = topology === "pentagonal" ? false : thingsEnabled;
    this.seed = seed >>> 0;
    this.topologyId = topology;
    this.store.setDirectMode(topology === "pentagonal");
    this.score = 0;
    this.things = 0;
    this.health = DIFFICULTIES[mode].startingHealth;
    this.cheats = 0;
    this.started = false;
    this.bounds = null;
    this.safeCells.clear();
    this.thingCache.clear();
    this.store.clear();
    return autoStart ? this.reveal(0, 0) : EMPTY_RESULT();
  }

  cheatDeath(): boolean {
    if (!this.canCheatDeath) return false;
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
    const zoneX = floorDiv(x, THING_ZONE_SIZE);
    const zoneY = floorDiv(y, THING_ZONE_SIZE);
    const thing = this.artifactForZone(zoneX, zoneY);
    if (this.thingLayoutReservesCell(thing, zoneX, zoneY, x, y)) return false;
    if (thing !== null && x === thing.x && y === thing.y) return false;
    return this.rawMineAt(x, y);
  }

  artifactAt(x: number, y: number): boolean {
    const zoneX = floorDiv(x, THING_ZONE_SIZE);
    const zoneY = floorDiv(y, THING_ZONE_SIZE);
    const artifact = this.artifactForZone(zoneX, zoneY);
    return artifact !== null && x === artifact.x && y === artifact.y;
  }

  thingVisualAt(x: number, y: number): ThingVisual | null {
    if (!this.thingsEnabled) return null;
    const zoneX = floorDiv(x, THING_ZONE_SIZE);
    const zoneY = floorDiv(y, THING_ZONE_SIZE);
    const artifact = this.artifactForZone(zoneX, zoneY);
    if (artifact === null || x !== artifact.x || y !== artifact.y) return null;
    const decodeCells = (mask: Uint32Array): Array<{ x: number; y: number }> => {
      const decoded: Array<{ x: number; y: number }> = [];
      for (let index = 0; index < THING_ZONE_SIZE * THING_ZONE_SIZE; index += 1) {
        if ((mask[index >>> 5] & (1 << (index & 31))) === 0) continue;
        decoded.push({
          x: zoneX * THING_ZONE_SIZE + (index % THING_ZONE_SIZE),
          y: zoneY * THING_ZONE_SIZE + Math.floor(index / THING_ZONE_SIZE),
        });
      }
      return decoded;
    };
    const cells = decodeCells(artifact.visual);
    const artCells = decodeCells(artifact.art);
    const reservedCells = decodeCells(artifact.reserved);
    return {
      x: artifact.x,
      y: artifact.y,
      cells,
      artCells,
      reservedCells,
      side: artifact.spriteSide,
      sprite: thingSpriteFor(artifact.x, artifact.y, this.seed),
    };
  }

  thingFootprintAt(x: number, y: number): boolean {
    if (!this.thingsEnabled) return false;
    const zoneX = floorDiv(x, THING_ZONE_SIZE);
    const zoneY = floorDiv(y, THING_ZONE_SIZE);
    return this.thingLayoutReservesCell(this.artifactForZone(zoneX, zoneY), zoneX, zoneY, x, y);
  }

  private thingLayoutReservesCell(
    thing: ThingLayout | null,
    zoneX: number,
    zoneY: number,
    x: number,
    y: number,
  ): boolean {
    if (!thing) return false;
    const localX = x - zoneX * THING_ZONE_SIZE;
    const localY = y - zoneY * THING_ZONE_SIZE;
    const index = localY * THING_ZONE_SIZE + localX;
    return (thing.reserved[index >>> 5] & (1 << (index & 31))) !== 0;
  }

  private rawMineAt(x: number, y: number): boolean {
    const topologySalt =
      this.topologyId === "square"
        ? 0
        : this.topologyId === "triangular"
          ? 0x34c1a5d7
          : this.topologyId === "rhombille"
            ? 0x69b284eb
            : 0x17d4c6af;
    return hash32(x, y, this.seed, 0x51ed270b ^ topologySalt) / UINT32_RANGE < this.density;
  }

  private thingSpatialTemplate(anchorX: number, anchorY: number, count: number): readonly { x: number; y: number }[] {
    const variant =
      this.topologyId === "triangular"
        ? positiveModulo(anchorX + anchorY, 2)
        : this.topologyId === "rhombille"
          ? positiveModulo(anchorX, 3)
          : 0;
    const cacheKey = `${this.topologyId}:${variant}:${count}`;
    const cached = THING_SPATIAL_TEMPLATE_CACHE.get(cacheKey);
    if (cached) return cached;

    const anchorCenter = this.topology.geometry(anchorX, anchorY).center;
    const frontier: Array<{ x: number; y: number; distance: number }> = [];
    const queued = new Set<string>();
    const enqueue = (x: number, y: number): void => {
      const key = `${x},${y}`;
      if (queued.has(key)) return;
      queued.add(key);
      const center = this.topology.geometry(x, y).center;
      frontier.push({
        x,
        y,
        distance: (center.x - anchorCenter.x) ** 2 + (center.y - anchorCenter.y) ** 2,
      });
    };
    enqueue(anchorX, anchorY);
    const cells: Array<{ x: number; y: number }> = [];
    while (cells.length < count) {
      frontier.sort((left, right) => {
        const distance = left.distance - right.distance;
        return Math.abs(distance) > 1e-12 ? distance : left.y - right.y || left.x - right.x;
      });
      const candidate = frontier.shift();
      if (!candidate) throw new Error("Thing spatial template cannot reach its requested cell count");
      cells.push({ x: candidate.x - anchorX, y: candidate.y - anchorY });
      for (const neighbor of this.topology.edgeNeighbors(candidate.x, candidate.y)) enqueue(neighbor.x, neighbor.y);
    }
    THING_SPATIAL_TEMPLATE_CACHE.set(cacheKey, cells);
    return cells;
  }

  private artifactForZone(zoneX: number, zoneY: number): ThingLayout | null {
    if (!this.thingsEnabled) return null;
    const key = `${zoneX},${zoneY}`;
    const cached = this.thingCache.get(key);
    if (cached) return cached;

    const artifact = this.thingForZone(zoneX, zoneY);
    this.thingCache.set(key, artifact);
    while (this.thingCache.size > MAX_THING_CACHE_ZONES) {
      const oldest = this.thingCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.thingCache.delete(oldest);
    }
    return artifact;
  }

  private thingForZone(zoneX: number, zoneY: number): ThingLayout {
    const sizeRoll = hash32(zoneX, zoneY, this.seed, 0x71a55e31) / UINT32_RANGE;
    const reservedSide = thingReservedSideForRoll(sizeRoll);
    const spriteSide = reservedSide - 2;
    const positionCount = THING_ZONE_SIZE - spriteSide - 2;
    const anchorLocalX = 1 + Math.floor((hash32(zoneX, zoneY, this.seed, 0x2f4b8d19) / UINT32_RANGE) * positionCount);
    const anchorLocalY = 1 + Math.floor((hash32(zoneX, zoneY, this.seed, 0x5c92d047) / UINT32_RANGE) * positionCount);
    const minLocalX = anchorLocalX - 1;
    const minLocalY = anchorLocalY - 1;
    const reservedCells = reservedSide * reservedSide;
    const mask = new Uint32Array((THING_ZONE_SIZE * THING_ZONE_SIZE) >>> 5);
    const members = new Set<number>();
    const addLocal = (localX: number, localY: number): void => {
      members.add(localY * THING_ZONE_SIZE + localX);
    };
    for (let localY = minLocalY; localY < minLocalY + reservedSide; localY += 1) {
      for (let localX = minLocalX; localX < minLocalX + reservedSide; localX += 1) addLocal(localX, localY);
    }

    let artifactLocalX = anchorLocalX;
    let artifactLocalY = anchorLocalY;
    if (this.topologyId !== "square") {
      const centerX = minLocalX + Math.floor(reservedSide / 2);
      const centerY = minLocalY + Math.floor(reservedSide / 2);
      let foundContainedAnchor = false;
      for (let radius = 0; radius < THING_ZONE_SIZE && !foundContainedAnchor; radius += 1) {
        for (let localY = centerY - radius; localY <= centerY + radius && !foundContainedAnchor; localY += 1) {
          for (let localX = centerX - radius; localX <= centerX + radius; localX += 1) {
            if (Math.max(Math.abs(localX - centerX), Math.abs(localY - centerY)) !== radius) continue;
            if (localX < 0 || localX >= THING_ZONE_SIZE || localY < 0 || localY >= THING_ZONE_SIZE) continue;
            const worldX = zoneX * THING_ZONE_SIZE + localX;
            const worldY = zoneY * THING_ZONE_SIZE + localY;
            const templateFits = this.thingSpatialTemplate(worldX, worldY, reservedCells).every(
              (offset) =>
                localX + offset.x >= 0 &&
                localX + offset.x < THING_ZONE_SIZE &&
                localY + offset.y >= 0 &&
                localY + offset.y < THING_ZONE_SIZE,
            );
            if (!templateFits) continue;
            {
              const sprite = thingSpriteFor(worldX, worldY, this.seed);
              let artSafetyFits = true;
              const artOffsets = thingAlphaOffsets(this.topologyId, worldX, worldY, spriteSide, sprite);
              for (let offset = 0; offset < artOffsets.length && artSafetyFits; offset += 2) {
                const artX = worldX + artOffsets[offset];
                const artY = worldY + artOffsets[offset + 1];
                const artLocalX = artX - zoneX * THING_ZONE_SIZE;
                const artLocalY = artY - zoneY * THING_ZONE_SIZE;
                if (
                  artLocalX < 0 ||
                  artLocalX >= THING_ZONE_SIZE ||
                  artLocalY < 0 ||
                  artLocalY >= THING_ZONE_SIZE
                ) {
                  artSafetyFits = false;
                  break;
                }
                this.topology.forEachNeighbor(artX, artY, (neighborX, neighborY) => {
                  const neighborLocalX = neighborX - zoneX * THING_ZONE_SIZE;
                  const neighborLocalY = neighborY - zoneY * THING_ZONE_SIZE;
                  if (
                    neighborLocalX < 0 ||
                    neighborLocalX >= THING_ZONE_SIZE ||
                    neighborLocalY < 0 ||
                    neighborLocalY >= THING_ZONE_SIZE
                  ) {
                    artSafetyFits = false;
                  }
                });
              }
              if (!artSafetyFits) continue;
            }
            let neighborsFit = true;
            this.topology.forEachNeighbor(worldX, worldY, (neighborX, neighborY) => {
              const neighborLocalX = neighborX - zoneX * THING_ZONE_SIZE;
              const neighborLocalY = neighborY - zoneY * THING_ZONE_SIZE;
              if (
                neighborLocalX < 0 ||
                neighborLocalX >= THING_ZONE_SIZE ||
                neighborLocalY < 0 ||
                neighborLocalY >= THING_ZONE_SIZE
              ) {
                neighborsFit = false;
              }
            });
            if (!neighborsFit) continue;
            artifactLocalX = localX;
            artifactLocalY = localY;
            foundContainedAnchor = true;
            break;
          }
        }
      }
      if (!foundContainedAnchor) throw new Error("Thing cannot place its topology patch inside its zone");
    }

    const visualMembers = new Set<number>();
    if (this.topologyId === "square") {
      for (let localY = anchorLocalY; localY < anchorLocalY + spriteSide; localY += 1) {
        for (let localX = anchorLocalX; localX < anchorLocalX + spriteSide; localX += 1) {
          visualMembers.add(localY * THING_ZONE_SIZE + localX);
        }
      }
    } else {
      // Logical x/y rectangles are not physical patches in the alternate
      // topology coordinate systems (especially Rhombille's three slots per
      // lattice point). Choose both the artwork and its larger safe footprint
      // by actual rendered distance from the discovery cell instead. The
      // resulting Thing is a compact union of real triangles/rhombi.
      const artifactX = zoneX * THING_ZONE_SIZE + artifactLocalX;
      const artifactY = zoneY * THING_ZONE_SIZE + artifactLocalY;
      const template = this.thingSpatialTemplate(artifactX, artifactY, reservedCells);
      const spatiallyNearest = template.map((offset) => {
        const localX = artifactLocalX + offset.x;
        const localY = artifactLocalY + offset.y;
        if (localX < 0 || localX >= THING_ZONE_SIZE || localY < 0 || localY >= THING_ZONE_SIZE) {
          throw new Error("Thing spatial template escaped its zone");
        }
        return { index: localY * THING_ZONE_SIZE + localX };
      });
      for (let index = 0; index < spriteSide * spriteSide; index += 1) {
        visualMembers.add(spatiallyNearest[index].index);
      }
      members.clear();
      for (const visualIndex of visualMembers) members.add(visualIndex);

      const protectedCells = new Set(visualMembers);
      const artifactIndex = artifactLocalY * THING_ZONE_SIZE + artifactLocalX;
      protectedCells.add(artifactIndex);
      this.topology.forEachNeighbor(
        zoneX * THING_ZONE_SIZE + artifactLocalX,
        zoneY * THING_ZONE_SIZE + artifactLocalY,
        (neighborX, neighborY) => {
          const localX = neighborX - zoneX * THING_ZONE_SIZE;
          const localY = neighborY - zoneY * THING_ZONE_SIZE;
          if (localX < 0 || localX >= THING_ZONE_SIZE || localY < 0 || localY >= THING_ZONE_SIZE) {
            throw new Error("Thing anchor cannot protect neighbors outside its zone");
          }
          protectedCells.add(localY * THING_ZONE_SIZE + localX);
        },
      );
      if (protectedCells.size > reservedCells) {
        throw new Error("Thing footprint cannot retain its visual and clue-zero cells");
      }
      for (const protectedIndex of protectedCells) members.add(protectedIndex);
      for (const candidate of spatiallyNearest) {
        if (members.size >= reservedCells) break;
        members.add(candidate.index);
      }
    }

    const artifactIndex = artifactLocalY * THING_ZONE_SIZE + artifactLocalX;
    if (!members.has(artifactIndex)) throw new Error("Thing footprint must contain its discovery cell");
    if (members.size < reservedCells) throw new Error("Thing footprint must preserve its base reserved-cell count");
    const visualMask = new Uint32Array(mask.length);
    const artMask = new Uint32Array(mask.length);
    for (const index of visualMembers) visualMask[index >>> 5] |= 1 << (index & 31);
    const artifactX = zoneX * THING_ZONE_SIZE + artifactLocalX;
    const artifactY = zoneY * THING_ZONE_SIZE + artifactLocalY;
    const sprite = thingSpriteFor(artifactX, artifactY, this.seed);
    const artOffsets = thingAlphaOffsets(this.topologyId, artifactX, artifactY, spriteSide, sprite);
    for (let offset = 0; offset < artOffsets.length; offset += 2) {
      const localX = artifactLocalX + artOffsets[offset];
      const localY = artifactLocalY + artOffsets[offset + 1];
      const index = localY * THING_ZONE_SIZE + localX;
      if (!members.has(index)) {
        throw new Error(
          `Thing alpha footprint escaped its mine-free reservation: ${this.topologyId}/${artifactX},${artifactY}/${spriteSide}/${sprite}/${artOffsets[offset]},${artOffsets[offset + 1]}`,
        );
      }
      artMask[index >>> 5] |= 1 << (index & 31);
      this.topology.forEachNeighbor(
        artifactX + artOffsets[offset],
        artifactY + artOffsets[offset + 1],
        (neighborX, neighborY) => {
          const neighborLocalX = neighborX - zoneX * THING_ZONE_SIZE;
          const neighborLocalY = neighborY - zoneY * THING_ZONE_SIZE;
          if (
            neighborLocalX < 0 ||
            neighborLocalX >= THING_ZONE_SIZE ||
            neighborLocalY < 0 ||
            neighborLocalY >= THING_ZONE_SIZE
          ) {
            throw new Error("Thing art safety ring escaped its zone");
          }
          members.add(neighborLocalY * THING_ZONE_SIZE + neighborLocalX);
        },
      );
    }
    for (const index of members) mask[index >>> 5] |= 1 << (index & 31);
    return {
      x: artifactX,
      y: artifactY,
      spriteSide,
      reserved: mask,
      visual: visualMask,
      art: artMask,
    };
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

    let queue = new Int32Array(Math.max(192, Math.ceil(initial.length / 2) * 3));
    let head = 0;
    let tail = 0;
    let scheduledMines = 0;
    let scheduledSafeCells = 0;
    // Below the site-percolation threshold an infinite hyperbolic zero-clue
    // component can be genuinely unbounded. Limit one action's work while
    // leaving its covered boundary available for the next reveal.
    const maxScheduledSafeCells = this.topologyId === "pentagonal" ? 128 : Number.POSITIVE_INFINITY;
    const enqueue = (x: number, y: number, knownMine?: boolean, allowFlaggedMine = false): void => {
      const state = this.store.get(x, y);
      if (isOpened(state) || state === CellState.Exploded || state === CellState.Queued) return;
      if (state === CellState.Flagged && !allowFlaggedMine) return;
      const mine = knownMine ?? this.mineAt(x, y);
      if (state === CellState.Flagged && !mine) return;
      if (mine && scheduledMines >= MAX_CHAIN_EXPLOSIONS_PER_ACTION) return;
      if (!mine && scheduledSafeCells >= maxScheduledSafeCells) return;
      this.store.set(x, y, CellState.Queued);
      if (!mine) scheduledSafeCells += 1;
      if (tail + 3 > queue.length) {
        const expanded = new Int32Array(queue.length * 2);
        expanded.set(queue);
        queue = expanded;
      }
      queue[tail++] = x;
      queue[tail++] = y;
      queue[tail++] = mine ? 1 : 0;
      if (mine) scheduledMines += 1;
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
      const mine = queue[head++] === 1;
      if (damage === null) damage = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        damage.minX = Math.min(damage.minX, x);
        damage.minY = Math.min(damage.minY, y);
        damage.maxX = Math.max(damage.maxX, x);
        damage.maxY = Math.max(damage.maxY, y);
      }

      if (mine) {
        this.store.set(x, y, CellState.Exploded);
        this.extendBounds(x, y);
        exploded = true;
        changed += 1;
        // Blast propagation is breadth-first and counts every directly selected
        // or recursively reached mine against one hard per-action budget. This
        // preserves a visible chain reaction without allowing an infinite mine
        // component to monopolize the main thread.
        this.forEachNeighbor(x, y, (neighborX, neighborY) => {
          const neighborState = this.store.get(neighborX, neighborY);
          if (
            isOpened(neighborState) ||
            neighborState === CellState.Exploded ||
            neighborState === CellState.Queued
          ) {
            return;
          }
          const neighborMine = this.mineAt(neighborX, neighborY);
          enqueue(neighborX, neighborY, neighborMine, neighborMine);
        });
        continue;
      }

      const clue = this.clueAt(x, y);
      this.store.set(x, y, openedState(clue));
      this.extendBounds(x, y);
      changed += 1;
      scoreDelta += clue;
      if (clue === 0 && this.artifactAt(x, y)) thingsDelta += 1;
      if (clue === 0) {
        this.forEachNeighbor(x, y, (neighborX, neighborY) => enqueue(neighborX, neighborY, false));
      }
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
