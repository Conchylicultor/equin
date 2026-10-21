import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import type { ConfigProxy } from "./config-proxy";
import { APP_SCOPE_DIR } from "./scope-format";
import type { Disposable, JsonValue } from "./types";

/**
 * The three files a config document is made of. The user layer keeps all
 * three; every write path touches some subset, and the agent-write ledger
 * always captures the whole trio:
 *
 * - `origin` — `<name>.origin.jsonc`, the git layer as the build propagated it
 *   (or, for a runtime fork, the snapshot the fork wrote);
 * - `override` — `<name>.jsonc`, the user's own document;
 * - `ancestor` — `<name>.ancestor.jsonc`, the three-way-merge base `propagate`
 *   captured at the conflict transition.
 */
export type ConfigDocumentFile = "origin" | "override" | "ancestor";

/** One config document: a descriptor's store path, in a scope (`undefined` or `""` is the base). */
export interface ConfigDocRef {
  storePath: string;
  scopeId?: string;
}

/** One file of a config document. */
export interface ConfigFileRef extends ConfigDocRef {
  file: ConfigDocumentFile;
}

/**
 * Where the USER layer's documents live — the seam the server's registry reads
 * and writes through, so the same registry runs over files on the desktop and
 * over memory in a host without the computer. The tier cascade (`effective`,
 * `readTypedConfig`) reads each document's `proxy`; a write goes through
 * `edit`, which a store that keeps an agent-write ledger wraps in its record /
 * note-complete pair.
 *
 * The git layer is not here: the running registry never resolves values from
 * the repo — it cascades over the build-propagated `origin` — so the only
 * committed-layer read it makes is {@link ConfigGitLayerImpl.hasScope}.
 */
export interface ConfigStoreImpl {
  /** Synchronous read / write / exists of one file. */
  proxy(ref: ConfigFileRef): ConfigProxy;
  /** Remove one file; a no-op when it is absent. */
  remove(ref: ConfigFileRef): void;
  /** An identity for one file's current content: `"-"` when absent, and changed by every write. */
  stamp(ref: ConfigFileRef): string;
  /**
   * The scope ids the store holds a scope for, under `storePath`'s hierarchy
   * (a scope may hold another descriptor's documents only — callers filter
   * through the document's own files).
   */
  scopes(storePath: string): string[];
  /** Drop a scope's container once it holds nothing more (a no-op while it still does). */
  dropScope(storePath: string, scopeId: string): void;
  /**
   * Hear the document's `origin` / `override` change OUT OF BAND — a writer
   * that is not this registry. Every in-process writer refreshes itself, so a
   * store with no out-of-band writer may never call back.
   */
  watch(ref: ConfigDocRef, onChange: () => void): Disposable;
  /** Settles once `watch` callbacks flow; rejects when watching failed to start. */
  armed(): Promise<void>;
  /**
   * Run one mutation of `doc`'s files. `writer` and `operation` are for a store
   * that ledgers agent-origin writes: it captures the trio before `mutate` and
   * what it left after. `mutate` is synchronous — its file writes have landed
   * when it returns.
   */
  edit<T>(
    doc: ConfigDocRef,
    writer: WriteOrigin,
    operation: string,
    mutate: () => T,
  ): T;
}

/** The committed (repo) layer, as far as the running registry reads it. */
export interface ConfigGitLayerImpl {
  /**
   * Whether the repo commits a scoped document for (`storePath`, `appId`) —
   * `config/<hier>/@app/<appId>/<name>.jsonc`. Such a scope survives
   * un-forking: removal drops the user's runtime override and falls back to the
   * committed scope.
   */
  hasScope(storePath: string, appId: string): boolean;
}

const FILE_SUFFIX: Record<ConfigDocumentFile, string> = {
  origin: ".origin.jsonc",
  override: ".jsonc",
  ancestor: ".ancestor.jsonc",
};

/** A store path `<hier>/<name>.jsonc` split into its hierarchy and descriptor name. */
export function storePathParts(storePath: string): {
  hier: string;
  name: string;
} {
  const parts = storePath.replace(/\.jsonc$/, "").split("/");
  return { hier: parts.slice(0, -1).join("/"), name: parts[parts.length - 1]! };
}

/**
 * The path segment a scope adds under a hierarchy: `""` for the base, `@app/<id>`
 * for `app:<id>`. The scope id's wire format is `<kind>:<id>` — config_v2 treats
 * it as an opaque kind tag and never imports the apps plugin. Today the only
 * kind is `app`.
 */
export function scopeSegment(scopeId?: string): string {
  if (!scopeId) return "";
  const [kind, ...rest] = scopeId.split(":");
  if (kind !== "app") throw new Error(`Unknown scope kind: ${kind}`);
  return `${APP_SCOPE_DIR}/${rest.join(":")}`;
}

/**
 * Where a file of a config document sits under a layer's root —
 * `<hier>[/@app/<id>]/<name>{.origin,,.ancestor}.jsonc`. THE layout, shared by
 * every store that keeps documents as files.
 */
export function configFileRelPath(ref: ConfigFileRef): string {
  const { hier, name } = storePathParts(ref.storePath);
  return [hier, scopeSegment(ref.scopeId), `${name}${FILE_SUFFIX[ref.file]}`]
    .filter((s) => s !== "")
    .join("/");
}

/**
 * A user layer held in memory: what a demo scope writes to. Lives exactly as
 * long as its owner (a remount or reload is the committed state again); a
 * persistent store (IndexedDB / OPFS) implements the same interface.
 *
 * Every writer is in-process, so `watch` never calls back, `armed` resolves at
 * once, and `edit` keeps no ledger.
 */
export function createMemoryConfigStore(): ConfigStoreImpl {
  const docs = new Map<
    string,
    { content: JsonValue; hash: string | null; version: number }
  >();
  let writes = 0;
  const scopeOf = (ref: ConfigDocRef) => ref.scopeId ?? "";
  const keyOf = (ref: ConfigFileRef) =>
    `${ref.storePath}\0${scopeOf(ref)}\0${ref.file}`;
  return {
    proxy(ref) {
      const key = keyOf(ref);
      return {
        read: () => {
          const doc = docs.get(key);
          return doc ? { content: doc.content, hash: doc.hash } : null;
        },
        write: (content, hash) => {
          docs.set(key, { content, hash, version: ++writes });
        },
        exists: () => docs.has(key),
      };
    },
    remove(ref) {
      docs.delete(keyOf(ref));
    },
    stamp(ref) {
      const doc = docs.get(keyOf(ref));
      return doc ? `w${doc.version}` : "-";
    },
    scopes(storePath) {
      const { hier } = storePathParts(storePath);
      const ids = new Set<string>();
      for (const key of docs.keys()) {
        const [path, scopeId] = key.split("\0");
        if (scopeId && storePathParts(path!).hier === hier) ids.add(scopeId);
      }
      return [...ids].sort();
    },
    dropScope() {
      // A scope here is its documents: once they are removed it is gone.
    },
    watch() {
      return { dispose: () => {} };
    },
    armed: () => Promise.resolve(),
    edit: (_doc, _writer, _operation, mutate) => mutate(),
  };
}
