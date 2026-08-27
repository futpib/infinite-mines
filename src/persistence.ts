import type { GameSnapshotV1 } from "./model";

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

const DATABASE_NAME = "infinite-mines";
const DATABASE_VERSION = 1;
const STORE_NAME = "sessions";
const ACTIVE_GAME_KEY = "active";

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

export async function loadActiveGame(): Promise<PersistedGameV1 | null> {
  try {
    const database = await openDatabase();
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(ACTIVE_GAME_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to read the saved game"));
    });
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return null;
    return value as PersistedGameV1;
  } catch {
    return null;
  }
}

export async function saveActiveGame(snapshot: PersistedGameV1): Promise<boolean> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(snapshot, ACTIVE_GAME_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Saved-game write was aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save the game"));
    });
    return true;
  } catch {
    return false;
  }
}
