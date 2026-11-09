import { propagateGitLayerDocument, type GitLayerDocument } from "./git-layer";
import {
  storePathParts,
  type ConfigDocRef,
  type ConfigFileRef,
  type ConfigStoreImpl,
} from "./store";
import type { ConfigProxy } from "./config-proxy";
import type { JsonValue } from "./types";
import type { HostStore } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";

/** One stored document of the layer. */
export interface MemoryConfigDoc {
  content: JsonValue;
  hash: string | null;
  version: number;
}

/**
 * A user layer held in memory: what a host without the computer (a browser
 * worker host) writes to. Lives exactly as long as its owner (a reload is the
 * committed state again); a persistent store (IndexedDB / OPFS) implements the
 * same interface.
 *
 * `propagatedFrom` is the committed layer it starts from: the first time any
 * method touches a storePath, the store propagates that path's committed
 * document into itself — through `propagateGitLayerDocument`, the same function
 * the desktop build propagates the checkout's `config/` into a file store with —
 * so its origins are what a fresh user's are. Lazy, so a document no registered
 * descriptor reads is never parsed. Without it, the store starts empty.
 *
 * `persist` keeps the layer in a browser host's storage: read back whole on
 * first use, every write and removal written through — so a persistent host
 * keeps the user's config across reloads. Propagation still runs per storePath
 * on first touch: over the stored origins, exactly as a desktop build
 * propagates the checkout's `config/` into an existing user layer.
 *
 * Every writer is in-process, so `watch` never calls back, `armed` resolves at
 * once, and `edit` keeps no ledger.
 */
export function createMemoryConfigStore(opts?: {
  propagatedFrom?: (
    storePath: string,
  ) => Promise<GitLayerDocument | undefined> | GitLayerDocument | undefined;
  persist?: () => HostStore<MemoryConfigDoc>;
}): ConfigStoreImpl {
  let loaded: Map<string, MemoryConfigDoc> | null = null;
  let writes = 0;
  /**
   * Which scopes hold documents, per hierarchy: hier → scope id → how many of
   * its documents are stored. Kept with every write and removal, so `scopes`
   * answers from it instead of scanning every stored key — a scan per call
   * made the registry's boot, which asks once per descriptor, quadratic.
   */
  const scopeIndex = new Map<string, Map<string, number>>();
  const indexScope = (key: string, delta: 1 | -1): void => {
    const [path, scopeId] = key.split("\0");
    if (!scopeId) return;
    const { hier } = storePathParts(path!);
    let counts = scopeIndex.get(hier);
    if (counts === undefined) scopeIndex.set(hier, (counts = new Map()));
    const next = (counts.get(scopeId) ?? 0) + delta;
    if (next === 0) counts.delete(scopeId);
    else counts.set(scopeId, next);
  };
  const persisted = (): HostStore<MemoryConfigDoc> | undefined =>
    opts?.persist?.();
  /** The layer, read back from `persist` on first use. */
  const docsMap = (): Map<string, MemoryConfigDoc> => {
    if (loaded === null) {
      loaded = new Map(persisted()?.loaded);
      for (const [key, doc] of loaded) {
        writes = Math.max(writes, doc.version);
        indexScope(key, 1);
      }
    }
    return loaded;
  };
  const docs = {
    get: (key: string) => docsMap().get(key),
    has: (key: string) => docsMap().has(key),
    /** Store a new version of `key` (its version numbered after every stored one). */
    write(key: string, content: JsonValue, hash: string | null): void {
      const map = docsMap();
      const doc = { content, hash, version: ++writes };
      if (!map.has(key)) indexScope(key, 1);
      map.set(key, doc);
      persisted()?.put(key, doc);
    },
    delete(key: string): void {
      if (docsMap().delete(key)) {
        indexScope(key, -1);
        persisted()?.delete(key);
      }
    },
    /** The scopes holding documents under `hier`. */
    scopesOf(hier: string): string[] {
      docsMap();
      return [...(scopeIndex.get(hier)?.keys() ?? [])].sort();
    },
  };
  // storePath → its propagation, run once (concurrent first touches share it).
  const seeded = new Map<string, Promise<void>>();
  const scopeOf = (ref: ConfigDocRef) => ref.scopeId ?? "";
  const keyOf = (ref: ConfigFileRef) =>
    `${ref.storePath}\0${scopeOf(ref)}\0${ref.file}`;
  const rawProxy = (ref: ConfigFileRef): ConfigProxy => {
    const key = keyOf(ref);
    return {
      read: () => {
        const doc = docs.get(key);
        return doc ? { content: doc.content, hash: doc.hash } : null;
      },
      write: (content, hash) => {
        docs.write(key, content, hash);
      },
      exists: () => docs.has(key),
    };
  };
  const seed = (storePath: string): Promise<void> => {
    const propagatedFrom = opts?.propagatedFrom;
    if (propagatedFrom === undefined) return Promise.resolve();
    let seeding = seeded.get(storePath);
    if (seeding === undefined) {
      seeding = (async () => {
        const doc = await propagatedFrom(storePath);
        if (doc !== undefined)
          propagateGitLayerDocument(storePath, doc, rawProxy);
      })().catch((err: unknown) => {
        // A failed propagation is not kept: the next touch of the path tries
        // again rather than failing until the store is rebuilt.
        seeded.delete(storePath);
        throw err;
      });
      seeded.set(storePath, seeding);
    }
    return seeding;
  };
  // The layer itself is memory; a method waits only for its storePath's
  // first propagation (the committed layer may be read off a disk).
  return {
    async read(ref) {
      await seed(ref.storePath);
      return rawProxy(ref).read();
    },
    async write(ref, content, hash) {
      await seed(ref.storePath);
      rawProxy(ref).write(content, hash);
    },
    async remove(ref) {
      await seed(ref.storePath);
      docs.delete(keyOf(ref));
    },
    async stamp(ref) {
      await seed(ref.storePath);
      const doc = docs.get(keyOf(ref));
      return doc ? `w${doc.version}` : "-";
    },
    async scopes(storePath) {
      await seed(storePath);
      return docs.scopesOf(storePathParts(storePath).hier);
    },
    async dropScope(storePath) {
      await seed(storePath);
      // A scope here is its documents: once they are removed it is gone.
    },
    // Never calls back (every writer is in-process), so it needs no seeding:
    // every read that follows propagates first.
    watch: () => ({ dispose: () => {} }),
    armed: () => Promise.resolve(),
    edit: async (doc, _writer, _operation, mutate) => {
      await seed(doc.storePath);
      return mutate();
    },
  };
}
