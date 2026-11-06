const store = new Map();

function readEntry(map, key) {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

export function createTtlCache({ ttlMs = 60_000 } = {}) {
  const local = new Map();
  return {
    get(key) {
      return readEntry(local, key);
    },
    set(key, value) {
      local.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    },
    clear() {
      local.clear();
    },
    size() {
      return local.size;
    },
  };
}

export function getCached(key) {
  return readEntry(store, key);
}

export function setCached(key, value, ttlMs = 60_000) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export async function cached(key, ttlMs, loader) {
  const hit = getCached(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  setCached(key, value, ttlMs);
  return value;
}

export function invalidateCache(prefix = "") {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of [...store.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}:`) || key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}
