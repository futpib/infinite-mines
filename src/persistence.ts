import { MODES, type GameSnapshot, type Mode } from "./model";
import { isTopologyId, type TopologyId } from "./topology";

export interface ViewSnapshot {
  version: 1;
  panX: number;
  panY: number;
  zoom: number;
}

export interface PersistedGame {
  version: 1;
  savedAt: number;
  model: GameSnapshot;
  view: ViewSnapshot;
}

export interface ActiveGameSlot {
  version: 1;
  topology: TopologyId;
  mode: Mode;
  thingsEnabled: boolean;
}

const DATABASE_NAME = "infinite-mines";
const DATABASE_VERSION = 1;
const STORE_NAME = "sessions";
const ACTIVE_SLOT_KEY = "active-slot";
const slotKey = (topology: TopologyId, mode: Mode, thingsEnabled: boolean): string =>
  `field:${topology}:${mode}:${thingsEnabled ? "things" : "plain"}`;

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
  const game = value as Partial<PersistedGame>;
  return (
    game.version === 1 &&
    typeof game.savedAt === "number" &&
    game.model?.version === 1 &&
    typeof game.model.thingsEnabled === "boolean" &&
    game.view?.version === 1
  );
};

const isActiveSlot = (value: unknown): value is ActiveGameSlot => {
  if (!value || typeof value !== "object") return false;
  const pointer = value as Partial<ActiveGameSlot>;
  return (
    pointer.version === 1 &&
    isTopologyId(pointer.topology) &&
    MODES.includes(pointer.mode as Mode) &&
    typeof pointer.thingsEnabled === "boolean"
  );
};

const slotForGame = (snapshot: PersistedGame): ActiveGameSlot | null => {
  if (
    snapshot.version !== 1 ||
    snapshot.model.version !== 1 ||
    !isTopologyId(snapshot.model.topology) ||
    !MODES.includes(snapshot.model.mode) ||
    typeof snapshot.model.thingsEnabled !== "boolean"
  ) {
    return null;
  }
  return {
    version: 1,
    topology: snapshot.model.topology,
    mode: snapshot.model.mode,
    thingsEnabled: snapshot.model.thingsEnabled,
  };
};

export async function loadActiveGame(): Promise<PersistedGame | null> {
  try {
    const database = await openDatabase();
    const pointer = await readStoredValue(database, ACTIVE_SLOT_KEY);
    if (!isActiveSlot(pointer)) return null;
    const active = await readStoredValue(
      database,
      slotKey(pointer.topology, pointer.mode, pointer.thingsEnabled),
    );
    return isPersistedGame(active) ? active : null;
  } catch {
    return null;
  }
}

export async function loadGameSlot(
  topology: TopologyId,
  mode: Mode,
  thingsEnabled: boolean,
): Promise<PersistedGame | null> {
  try {
    const database = await openDatabase();
    const value = await readStoredValue(database, slotKey(topology, mode, thingsEnabled));
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
      store.put(snapshot, slotKey(slot.topology, slot.mode, slot.thingsEnabled));
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
