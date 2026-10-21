import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import type { ConfigProxy } from "./config-proxy";
import type { GitLayerDocument } from "./git-layer";
import { APP_SCOPE_DIR, appScopeId } from "./scope-format";
import type { Disposable } from "./types";

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
 * the repo — it cascades over the propagated `origin` (the build propagates it
 * into a file store; a memory store propagates it itself, on first touch) — so
 * the registry's only committed-layer read is whether a scope is committed
 * ({@link ConfigGitLayerImpl.document}).
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

/**
 * The committed (repo) layer: one descriptor's git-layer document, resolved
 * (`committedDocument` — `override ⊕ origin`, each `@app/<id>` delta over that
 * base), or `undefined` when the repo commits nothing at `storePath`.
 *
 * The desktop reads it off the checkout's `config/`; a browser host off the
 * `config/` bundled into it. Read by the registry to decide whether a scope
 * survives un-forking (a committed scope does), and by a memory store to
 * propagate the committed layer into itself.
 */
export interface ConfigGitLayerImpl {
  document(storePath: string): GitLayerDocument | undefined;
}

const FILE_SUFFIX: Record<ConfigDocumentFile, string> = {
  origin: ".origin.jsonc",
  override: ".jsonc",
  ancestor: ".ancestor.jsonc",
};

// Longest suffix first: every file name ends in ".jsonc".
const SUFFIX_ORDER: ConfigDocumentFile[] = ["origin", "ancestor", "override"];

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
 * The inverse of {@link configFileRelPath}: which file of which document a
 * layer-relative path names. Throws on a path outside the layout (not a
 * `.jsonc`, a misplaced `@app` segment) — a layer holding such a file is not
 * a config layer.
 */
export function parseConfigFileRelPath(rel: string): ConfigFileRef {
  const segments = rel.split("/");
  const fileName = segments.pop()!;
  const file = SUFFIX_ORDER.find((f) => fileName.endsWith(FILE_SUFFIX[f]));
  const name =
    file === undefined ? "" : fileName.slice(0, -FILE_SUFFIX[file].length);
  if (file === undefined || name === "") {
    throw new Error(`Not a config file path: "${rel}"`);
  }
  let scopeId: string | undefined;
  if (segments.length >= 2 && segments[segments.length - 2] === APP_SCOPE_DIR) {
    scopeId = appScopeId(segments.pop()!);
    segments.pop();
  }
  if (segments.length === 0 || segments.includes(APP_SCOPE_DIR)) {
    throw new Error(`Not a config file path: "${rel}"`);
  }
  const storePath = `${segments.join("/")}/${name}.jsonc`;
  return scopeId === undefined
    ? { storePath, file }
    : { storePath, scopeId, file };
}
