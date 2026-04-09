/**
 * Simple in-memory message deduplication to prevent re-processing
 * the same webhook request that arrives more than once (e.g., middleware retries).
 *
 * Uses a TTL-based LRU-like eviction to cap memory usage.
 */

const DEDUP_TTL_MS = 60_000; // 1 minute
const MAX_ENTRIES = 2_000;

type Entry = { seenAt: number };

const store = new Map<string, Entry>();

/** Evict entries that have exceeded the TTL. */
function evict(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.seenAt > DEDUP_TTL_MS) {
      store.delete(key);
    }
  }
}

/**
 * Returns true if this key was already seen within the TTL window (duplicate).
 * Side effect: records the key so the next call with the same key returns true.
 */
export function checkAndMarkSeen(key: string): boolean {
  evict();
  if (store.has(key)) {
    return true; // duplicate — already seen
  }
  // Evict oldest entry if at capacity (approximate LRU)
  if (store.size >= MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, entry] of store) {
      if (entry.seenAt < oldestTs) {
        oldestTs = entry.seenAt;
        oldestKey = k;
      }
    }
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(key, { seenAt: Date.now() });
  return false;
}

/** For testing only: clear all entries. */
export function clearDedupStoreForTest(): void {
  store.clear();
}

/** For testing only: get current store size. */
export function getDedupStoreSizeForTest(): number {
  return store.size;
}
