import { MODES, type GameSnapshotV1, type GameSnapshotV2, type GameSnapshotV3, type Mode } from "./model";
import { isTopologyId, type TopologyId } from "./topology";

export interface ViewSnapshotV1 {
  version: 1;
  panX: number;
  panY: number;
  zoom: number;
}

export interface PersistedGameV1 {
  version: 1;
  savedAt: number;
  model: GameSnapshotV1;
  view: ViewSnapshotV1;
}

export interface PersistedGameV2 {
  version: 2;
  savedAt: number;
  model: GameSnapshotV2;
  view: ViewSnapshotV1;
}

export interface PersistedGameV3 {
  version: 3;
  savedAt: number;
  model: GameSnapshotV3;
  view: ViewSnapshotV1;
}

export type PersistedGame = PersistedGameV1 | PersistedGameV2 | PersistedGameV3;

export interface ActiveGameSlotV1 {
  version: 1;
  topology: TopologyId;
  mode: Mode;
}

const DATABASE_NAME = "infinite-mines";
const DATABASE_VERSION = 1;
const STORE_NAME = "sessions";
const ACTIVE_GAME_KEY = "active";
const ACTIVE_SLOT_KEY = "active-slot";
const slotKey = (topology: TopologyId, mode: Mode): string => `field:${topology}:${mode}`;

let databasePromise: Promise<IDBDatabase> | null = null;

const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open saved games"));
    request.onblocked = () => reject(new Error("Saved-game database upgrade was blocked"));
  });
  const pending = opening.catch((error) => {
    databasePromise = null;
    throw error;
  });
  databasePromise = pending;
  return pending;
};

const readStoredValue = async (database: IDBDatabase, key: string): Promise<unknown> =>
  new Promise<unknown>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to read the saved game"));
  });

const isPersistedGame = (value: unknown): value is PersistedGame => {
  if (!value || typeof value !== "object") return false;
  const version = (value as { version?: unknown }).version;
  return version === 1 || version === 2 || version === 3;
};

const isActiveSlot = (value: unknown): value is ActiveGameSlotV1 => {
  if (!value || typeof value !== "object") return false;
  const pointer = value as Partial<ActiveGameSlotV1>;
  return pointer.version === 1 && isTopologyId(pointer.topology) && MODES.includes(pointer.mode as Mode);
};

const slotForGame = (snapshot: PersistedGame): ActiveGameSlotV1 | null => {
  const topology =
    (snapshot.model.version === 2 || snapshot.model.version === 3) && isTopologyId(snapshot.model.topology)
      ? snapshot.model.topology
      : "square";
  if (!MODES.includes(snapshot.model.mode)) return null;
  return { version: 1, topology, mode: snapshot.model.mode };
};

export async function loadActiveGame(): Promise<PersistedGame | null> {
  try {
    const database = await openDatabase();
    const pointer = await readStoredValue(database, ACTIVE_SLOT_KEY);
    if (isActiveSlot(pointer)) {
      const active = await readStoredValue(database, slotKey(pointer.topology, pointer.mode));
      if (isPersistedGame(active)) return active;
    }

    const legacy = await readStoredValue(database, ACTIVE_GAME_KEY);
    if (!isPersistedGame(legacy)) return null;
    await saveActiveGame(legacy);
    return legacy;
  } catch {
    return null;
  }
}

export async function loadGameSlot(topology: TopologyId, mode: Mode): Promise<PersistedGame | null> {
  try {
    const database = await openDatabase();
    const value = await readStoredValue(database, slotKey(topology, mode));
    return isPersistedGame(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveActiveGame(snapshot: PersistedGame): Promise<boolean> {
  try {
    const slot = slotForGame(snapshot);
    if (!slot) return false;
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      store.put(snapshot, slotKey(slot.topology, slot.mode));
      store.put(slot, ACTIVE_SLOT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Saved-game write was aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save the game"));
    });
    return true;
  } catch {
    return false;
  }
}
