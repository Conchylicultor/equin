/**
 * An in-memory Storage with a byte quota, throwing the browser's
 * `QuotaExceededError` past it — the condition the 2026-10-19 incident hit and
 * jsdom never produces. Install with `installStorage`.
 */
export class QuotaStorage implements Storage {
  private store = new Map<string, string>();
  constructor(private readonly quotaBytes = Infinity) {}
  get length(): number {
    return this.store.size;
  }
  get bytes(): number {
    let total = 0;
    for (const [k, v] of this.store) total += 2 * (k.length + v.length);
    return total;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    const prev = this.store.get(key);
    const delta =
      2 * (key.length + value.length) -
      (prev === undefined ? 0 : 2 * (key.length + prev.length));
    if (this.bytes + delta > this.quotaBytes)
      throw new DOMException("quota exceeded", "QuotaExceededError");
    this.store.set(key, String(value));
  }
}

/** Make `window.<area>Storage` this storage for the rest of the test file. */
export function installStorage(
  area: "local" | "session",
  storage: Storage,
): void {
  Object.defineProperty(
    window,
    area === "local" ? "localStorage" : "sessionStorage",
    { value: storage, configurable: true },
  );
}
