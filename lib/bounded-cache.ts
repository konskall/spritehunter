/** In-memory cache with expiry and a hard entry limit (oldest insertion evicted first). */
export class TtlCache<V> {
  private entries = new Map<string, { expires: number; value: V }>();

  constructor(private maxEntries: number) {}

  get(key: string, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number, now = Date.now()) {
    this.entries.delete(key);
    this.entries.set(key, { expires: now + ttlMs, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** Shares one pending promise per key, so concurrent cache misses make a single upstream call. */
export class InFlight<V> {
  private pending = new Map<string, Promise<V>>();

  run(key: string, task: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = task().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
