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
  propagatedFrom?: (storePath: string) => GitLayerDocument | undefined;
  persist?: () => HostStore<MemoryConfigDoc>;
}): ConfigStoreImpl {
  let loaded: Map<string, MemoryConfigDoc> | null = null;
  let writes = 0;
  const persisted = (): HostStore<MemoryConfigDoc> | undefined =>
    opts?.persist?.();
  /** The layer, read back from `persist` on first use. */
  const docsMap = (): Map<string, MemoryConfigDoc> => {
    if (loaded === null) {
      loaded = new Map(persisted()?.loaded);
      for (const doc of loaded.values()) writes = Math.max(writes, doc.version);
    }
    return loaded;
  };
  const docs = {
    get: (key: string) => docsMap().get(key),
    has: (key: string) => docsMap().has(key),
    keys: () => docsMap().keys(),
    /** Store a new version of `key` (its version numbered after every stored one). */
    write(key: string, content: JsonValue, hash: string | null): void {
      const map = docsMap();
      const doc = { content, hash, version: ++writes };
      map.set(key, doc);
      persisted()?.put(key, doc);
    },
    delete(key: string): void {
      if (docsMap().delete(key)) persisted()?.delete(key);
    },
  };
  const seeded = new Set<string>();
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
  const seed = (storePath: string) => {
    if (opts?.propagatedFrom === undefined || seeded.has(storePath)) return;
    seeded.add(storePath);
    const doc = opts.propagatedFrom(storePath);
    if (doc !== undefined) propagateGitLayerDocument(storePath, doc, rawProxy);
  };
  return {
    proxy(ref) {
      seed(ref.storePath);
      return rawProxy(ref);
    },
    remove(ref) {
      seed(ref.storePath);
      docs.delete(keyOf(ref));
    },
    stamp(ref) {
      seed(ref.storePath);
      const doc = docs.get(keyOf(ref));
      return doc ? `w${doc.version}` : "-";
    },
    scopes(storePath) {
      seed(storePath);
      const { hier } = storePathParts(storePath);
      const ids = new Set<string>();
      for (const key of docs.keys()) {
        const [path, scopeId] = key.split("\0");
        if (scopeId && storePathParts(path!).hier === hier) ids.add(scopeId);
      }
      return [...ids].sort();
    },
    dropScope(storePath) {
      seed(storePath);
      // A scope here is its documents: once they are removed it is gone.
    },
    watch(ref) {
      seed(ref.storePath);
      return { dispose: () => {} };
    },
    armed: () => Promise.resolve(),
    edit: (doc, _writer, _operation, mutate) => {
      seed(doc.storePath);
      return mutate();
    },
  };
}
