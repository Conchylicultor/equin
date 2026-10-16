import type { ConfigProxy } from "./config-proxy";
import type { JsonValue } from "./types";

/**
 * Where a config layer's documents live, one `ConfigProxy` per
 * `{ path, scopeId? }` — the seam the tier cascade (`effective`,
 * `readTypedConfig`) reads and `setConfig` writes through. The server's user
 * layer is files (`jsoncConfigProxy`); a store is the same layer anywhere else.
 */
export interface ConfigStore {
  proxy(path: string, scopeId?: string): ConfigProxy;
}

/**
 * A user layer held in memory: what a demo scope writes to. Lives exactly as
 * long as its owner (a remount or reload is the committed state again); a
 * persistent store (IndexedDB / OPFS) implements the same interface.
 */
export function createMemoryConfigStore(): ConfigStore {
  const docs = new Map<string, { content: JsonValue; hash: string | null }>();
  return {
    proxy(path, scopeId) {
      const key = `${path}\0${scopeId ?? ""}`;
      return {
        read: () => {
          const doc = docs.get(key);
          return doc ? { ...doc } : null;
        },
        write: (content, hash) => {
          docs.set(key, { content, hash });
        },
        exists: () => docs.has(key),
      };
    },
  };
}
