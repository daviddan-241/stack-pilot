const DB_NAME = 'stackpilot-workspace';
const STORE = 'projects';
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open project storage.'));
  });
}

async function runTransaction(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let request;
    try {
      request = action(store);
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      resolve(request?.result);
      db.close();
    };
    transaction.onerror = () => {
      reject(transaction.error || request?.error || new Error('Project storage failed.'));
      db.close();
    };
    transaction.onabort = () => {
      reject(transaction.error || new Error('Project storage was interrupted.'));
      db.close();
    };
  });
}

export function getProjects() {
  return runTransaction('readonly', (store) => store.getAll());
}

export function saveProject(project) {
  return runTransaction('readwrite', (store) => store.put(project));
}

export function removeProject(id) {
  return runTransaction('readwrite', (store) => store.delete(id));
}

export function createProjectId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
