import { MODES, type GameSnapshot, type Mode } from "./model";
import { isTopologyId, type TopologyId } from "./topology";
import type { HyperbolicViewState } from "./hyperbolic-renderer";

export interface ViewSnapshot {
  version: 1;
  panX: number;
  panY: number;
  zoom: number;
  hyperbolic?: HyperbolicViewState;
}

export interface PersistedGame {
  version: 1;
  savedAt: number;
  model: GameSnapshot;
  view: ViewSnapshot;
}

export interface SavedField extends PersistedGame {
  recordVersion: 1;
  id: string;
  createdAt: number;
  pinned: boolean;
}

export interface SavedFieldTransition {
  field: SavedField;
  previousId: string | null;
}

interface ActiveFieldPointer {
  version: 1;
  id: string;
}

interface LegacyActiveGameSlot {
  version: 1;
  topology: TopologyId;
  mode: Mode;
  thingsEnabled: boolean;
}

const DATABASE_NAME = "infinite-mines";
const DATABASE_VERSION = 1;
const STORE_NAME = "sessions";
const LEGACY_ACTIVE_SLOT_KEY = "active-slot";
const ACTIVE_FIELD_KEY = "active-field";
const FIELD_KEY_PREFIX = "run:";
const LEGACY_FIELD_KEY_PREFIX = "field:";
export const MAX_RECENT_SAVED_FIELDS = 20;

let databasePromise: Promise<IDBDatabase> | null = null;
let migrationPromise: Promise<void> | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

const requestResult = <T>(request: IDBRequest<T>, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(message));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Saved-field transaction was aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Saved-field transaction failed"));
  });

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
    request.onerror = () => reject(request.error ?? new Error("Unable to open saved fields"));
    request.onblocked = () => reject(new Error("Saved-field database upgrade was blocked"));
  });
  databasePromise = opening.catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
};

const isPersistedGame = (value: unknown): value is PersistedGame => {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<PersistedGame>;
  return (
    game.version === 1 &&
    typeof game.savedAt === "number" &&
    game.model?.version === 1 &&
    isTopologyId(game.model.topology) &&
    MODES.includes(game.model.mode as Mode) &&
    typeof game.model.thingsEnabled === "boolean" &&
    game.view?.version === 1
  );
};

const isSavedField = (value: unknown): value is SavedField => {
  if (!isPersistedGame(value)) return false;
  const field = value as Partial<SavedField>;
  return (
    field.recordVersion === 1 &&
    typeof field.id === "string" &&
    field.id.length > 0 &&
    typeof field.createdAt === "number" &&
    typeof field.pinned === "boolean"
  );
};

const isActiveFieldPointer = (value: unknown): value is ActiveFieldPointer => {
  if (!value || typeof value !== "object") return false;
  const pointer = value as Partial<ActiveFieldPointer>;
  return pointer.version === 1 && typeof pointer.id === "string" && pointer.id.length > 0;
};

const isLegacyActiveSlot = (value: unknown): value is LegacyActiveGameSlot => {
  if (!value || typeof value !== "object") return false;
  const pointer = value as Partial<LegacyActiveGameSlot>;
  return (
    pointer.version === 1 &&
    isTopologyId(pointer.topology) &&
    MODES.includes(pointer.mode as Mode) &&
    typeof pointer.thingsEnabled === "boolean"
  );
};

const fieldKey = (id: string): string => `${FIELD_KEY_PREFIX}${id}`;

const makeId = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const asSavedField = (snapshot: PersistedGame, id = makeId(), createdAt = snapshot.savedAt): SavedField => ({
  ...snapshot,
  recordVersion: 1,
  id,
  createdAt,
  pinned: false,
});

const sortedNewestFirst = (fields: SavedField[]): SavedField[] =>
  fields.sort((a, b) => b.savedAt - a.savedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));

const readAllFieldsFromStore = async (store: IDBObjectStore): Promise<SavedField[]> => {
  const [keys, values] = await Promise.all([
    requestResult(store.getAllKeys(), "Unable to list saved-field keys"),
    requestResult(store.getAll(), "Unable to list saved fields"),
  ]);
  const fields: SavedField[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === "string" && key.startsWith(FIELD_KEY_PREFIX) && isSavedField(values[index])) {
      fields.push(values[index]);
    }
  }
  return sortedNewestFirst(fields);
};

const ensureMigrated = async (): Promise<void> => {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const finished = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const [keys, values, pointerValue] = await Promise.all([
      requestResult(store.getAllKeys(), "Unable to inspect saved-field keys"),
      requestResult(store.getAll(), "Unable to inspect saved fields"),
      requestResult(store.get(ACTIVE_FIELD_KEY), "Unable to read active field"),
    ]);

    const modernFields: SavedField[] = [];
    const legacyFields: Array<{ key: string; game: PersistedGame }> = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = values[index];
      if (typeof key !== "string") continue;
      if (key.startsWith(FIELD_KEY_PREFIX) && isSavedField(value)) modernFields.push(value);
      if (key.startsWith(LEGACY_FIELD_KEY_PREFIX) && isPersistedGame(value)) legacyFields.push({ key, game: value });
    }

    let pointer = isActiveFieldPointer(pointerValue) ? pointerValue : null;
    if (legacyFields.length > 0) {
      const legacyPointerValue = await requestResult(store.get(LEGACY_ACTIVE_SLOT_KEY), "Unable to read legacy active field");
      const legacyPointer = isLegacyActiveSlot(legacyPointerValue) ? legacyPointerValue : null;
      const migrated: Array<{ key: string; field: SavedField }> = legacyFields.map(({ key, game }, index) => {
        const id = `legacy-${Math.max(0, Math.floor(game.savedAt)).toString(36)}-${index.toString(36)}-${makeId()}`;
        return { key, field: asSavedField(game, id, game.savedAt) };
      });
      for (const { key, field } of migrated) {
        store.put(field, fieldKey(field.id));
        store.delete(key);
      }
      modernFields.push(...migrated.map(({ field }) => field));
      if (!pointer && legacyPointer) {
        const active = migrated
          .map(({ field }) => field)
          .filter(
            ({ model }) =>
              model.topology === legacyPointer.topology &&
              model.mode === legacyPointer.mode &&
              model.thingsEnabled === legacyPointer.thingsEnabled,
          )
          .sort((a, b) => b.savedAt - a.savedAt)[0];
        if (active) pointer = { version: 1, id: active.id };
      }
      store.delete(LEGACY_ACTIVE_SLOT_KEY);
    }

    if (!pointer || !modernFields.some(({ id }) => id === pointer?.id)) {
      const fallback = sortedNewestFirst(modernFields)[0];
      if (fallback) pointer = { version: 1, id: fallback.id };
    }
    if (pointer) store.put(pointer, ACTIVE_FIELD_KEY);
    else store.delete(ACTIVE_FIELD_KEY);
    await finished;
  })().catch((error) => {
    migrationPromise = null;
    throw error;
  });
  return migrationPromise;
};

const afterWrites = async (): Promise<IDBDatabase> => {
  await writeQueue;
  await ensureMigrated();
  return openDatabase();
};

const enqueueWrite = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = writeQueue.then(async () => {
    await ensureMigrated();
    return operation();
  });
  writeQueue = result.catch(() => undefined);
  return result;
};

const pruneUnpinned = (store: IDBObjectStore, fields: SavedField[], protectedIds: Set<string>): void => {
  const unpinned = sortedNewestFirst(fields.filter(({ pinned }) => !pinned));
  let retained = 0;
  for (const field of unpinned) {
    if (protectedIds.has(field.id) || retained < MAX_RECENT_SAVED_FIELDS) {
      retained += 1;
    } else {
      store.delete(fieldKey(field.id));
    }
  }
};

export async function loadActiveGame(): Promise<SavedField | null> {
  try {
    const database = await afterWrites();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const pointerValue = await requestResult(store.get(ACTIVE_FIELD_KEY), "Unable to read active field");
    if (!isActiveFieldPointer(pointerValue)) return null;
    const value = await requestResult(store.get(fieldKey(pointerValue.id)), "Unable to read active field");
    return isSavedField(value) ? value : null;
  } catch {
    return null;
  }
}

export async function listSavedFields(): Promise<SavedField[]> {
  try {
    const database = await afterWrites();
    const transaction = database.transaction(STORE_NAME, "readonly");
    return readAllFieldsFromStore(transaction.objectStore(STORE_NAME));
  } catch {
    return [];
  }
}

export async function loadSavedField(id: string): Promise<SavedField | null> {
  try {
    const database = await afterWrites();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const value = await requestResult(transaction.objectStore(STORE_NAME).get(fieldKey(id)), "Unable to read saved field");
    return isSavedField(value) ? value : null;
  } catch {
    return null;
  }
}

export async function loadGameSlot(
  topology: TopologyId,
  mode: Mode,
  thingsEnabled: boolean,
  density?: number,
): Promise<SavedField | null> {
  const fields = await listSavedFields();
  return (
    fields.find(
      ({ model }) =>
        model.topology === topology &&
        model.mode === mode &&
        model.thingsEnabled === thingsEnabled &&
        (density === undefined || model.density === density),
    ) ?? null
  );
}

export function saveActiveGame(snapshot: PersistedGame): Promise<SavedField | null> {
  if (!isPersistedGame(snapshot)) return Promise.resolve(null);
  return enqueueWrite(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const finished = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const pointerValue = await requestResult(store.get(ACTIVE_FIELD_KEY), "Unable to read active field");
    let field: SavedField;
    if (isActiveFieldPointer(pointerValue)) {
      const current = await requestResult(store.get(fieldKey(pointerValue.id)), "Unable to read active field");
      field = isSavedField(current)
        ? { ...current, ...snapshot, id: current.id, createdAt: current.createdAt, pinned: current.pinned, recordVersion: 1 }
        : asSavedField(snapshot, pointerValue.id);
    } else {
      field = asSavedField(snapshot);
    }
    store.put(field, fieldKey(field.id));
    store.put({ version: 1, id: field.id } satisfies ActiveFieldPointer, ACTIVE_FIELD_KEY);
    await finished;
    return field;
  }).catch(() => null);
}

export function archiveAndCreateSavedField(
  previousSnapshot: PersistedGame,
  nextSnapshot: PersistedGame,
): Promise<SavedFieldTransition | null> {
  if (!isPersistedGame(previousSnapshot) || !isPersistedGame(nextSnapshot)) return Promise.resolve(null);
  return enqueueWrite(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const finished = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const pointerValue = await requestResult(store.get(ACTIVE_FIELD_KEY), "Unable to read active field");
    let previousId: string | null = null;
    if (isActiveFieldPointer(pointerValue)) {
      const current = await requestResult(store.get(fieldKey(pointerValue.id)), "Unable to read active field");
      const archived = isSavedField(current)
        ? { ...current, ...previousSnapshot, id: current.id, createdAt: current.createdAt, pinned: current.pinned, recordVersion: 1 as const }
        : asSavedField(previousSnapshot, pointerValue.id);
      store.put(archived, fieldKey(archived.id));
      previousId = archived.id;
    } else {
      const archived = asSavedField(previousSnapshot);
      store.put(archived, fieldKey(archived.id));
      previousId = archived.id;
    }

    const field = asSavedField(nextSnapshot);
    store.put(field, fieldKey(field.id));
    store.put({ version: 1, id: field.id } satisfies ActiveFieldPointer, ACTIVE_FIELD_KEY);
    const fields = await readAllFieldsFromStore(store);
    const merged = fields.filter(({ id }) => id !== field.id);
    merged.push(field);
    pruneUnpinned(store, merged, new Set([field.id, previousId]));
    await finished;
    return { field, previousId };
  }).catch(() => null);
}

export function createSavedField(snapshot: PersistedGame): Promise<SavedFieldTransition | null> {
  if (!isPersistedGame(snapshot)) return Promise.resolve(null);
  return enqueueWrite(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const finished = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const pointerValue = await requestResult(store.get(ACTIVE_FIELD_KEY), "Unable to read active field");
    const previousId = isActiveFieldPointer(pointerValue) ? pointerValue.id : null;
    const field = asSavedField(snapshot);
    store.put(field, fieldKey(field.id));
    store.put({ version: 1, id: field.id } satisfies ActiveFieldPointer, ACTIVE_FIELD_KEY);
    const fields = await readAllFieldsFromStore(store);
    const merged = fields.filter(({ id }) => id !== field.id);
    merged.push(field);
    pruneUnpinned(store, merged, new Set([field.id, previousId].filter((id): id is string => id !== null)));
    await finished;
    return { field, previousId };
  }).catch(() => null);
}

export function activateSavedField(id: string): Promise<SavedField | null> {
  return enqueueWrite(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const finished = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const value = await requestResult(store.get(fieldKey(id)), "Unable to read saved field");
    if (!isSavedField(value)) {
      transaction.abort();
      await finished.catch(() => undefined);
      return null;
    }
    const field = { ...value, savedAt: Date.now() };
    store.put(field, fieldKey(field.id));
    store.put({ version: 1, id: field.id } satisfies ActiveFieldPointer, ACTIVE_FIELD_KEY);
    await finished;
    return field;
  }).catch(() => null);
}

export function setSavedFieldPinned(id: string, pinned: boolean): Promise<SavedField | null> {
  return enqueueWrite(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const finished = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const value = await requestResult(store.get(fieldKey(id)), "Unable to read saved field");
    if (!isSavedField(value)) {
      transaction.abort();
      await finished.catch(() => undefined);
      return null;
    }
    const field = { ...value, pinned };
    store.put(field, fieldKey(field.id));
    await finished;
    return field;
  }).catch(() => null);
}

export function deleteSavedField(id: string): Promise<boolean> {
  return enqueueWrite(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const finished = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const pointerValue = await requestResult(store.get(ACTIVE_FIELD_KEY), "Unable to read active field");
    if (isActiveFieldPointer(pointerValue) && pointerValue.id === id) {
      transaction.abort();
      await finished.catch(() => undefined);
      return false;
    }
    store.delete(fieldKey(id));
    await finished;
    return true;
  }).catch(() => false);
}
