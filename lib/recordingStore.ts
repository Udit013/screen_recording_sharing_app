// IndexedDB persistence for in-progress recordings. Chunks are written as
// the MediaRecorder emits them, so a browser crash or accidental refresh
// mid-recording can be recovered on the next visit.

const DB_NAME = "snapcast-recorder";
const STORE = "chunks";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function appendRecordingChunk(chunk: Blob): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.add(chunk));
  } catch {
    // Persistence is best-effort; recording continues in memory regardless.
  }
}

export async function getRecoverableChunks(): Promise<Blob[]> {
  try {
    const all = await withStore<unknown[]>("readonly", (s) => s.getAll());
    return all.filter((c): c is Blob => c instanceof Blob);
  } catch {
    return [];
  }
}

export async function hasRecoverableRecording(): Promise<boolean> {
  try {
    const count = await withStore<number>("readonly", (s) => s.count());
    return count > 0;
  } catch {
    return false;
  }
}

export async function clearRecordingChunks(): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.clear());
  } catch {
    /* ignore */
  }
}
