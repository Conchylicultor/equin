import { parseConfigFile } from "./config-file";
import { readonlyProxy, type ConfigProxy } from "./config-proxy";
import { appScopeId, scopeAppId } from "./scope-format";
import {
  configFileRelPath,
  parseConfigFileRelPath,
  type ConfigDocRef,
  type ConfigFileRef,
} from "./store";
import { effective, propagate } from "./tier-logic";
import type { JsonValue } from "./types";

/**
 * One descriptor's COMMITTED config, resolved — what a fresh user's origin
 * layer holds after `./equin build` propagates the repo's `config/`:
 *
 * - `base`: the git-effective document (`override ⊕ origin`, a stale override
 *   losing to its origin — `effective`);
 * - `scopes`: app id → that `@app/<id>` scope's document, the base-anchored
 *   delta resolved over `base` (`{ ...base, ...delta }`).
 */
export interface GitLayerDocument {
  base: JsonValue;
  scopes: Record<string, JsonValue>;
}

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, JsonValue>)
    : {};
}

/**
 * THE git-layer rule, spelled once: the build's propagation into a user layer
 * (`propagateConfigToUser`) and the committed layer a host reads
 * ({@link committedDocument}) both resolve through it, so the two cannot
 * disagree. `undefined` when the
 * git layer has no document at all (no origin, no override). A scope whose
 * delta file is absent is omitted.
 */
export function resolveGitLayer(
  origin: ConfigProxy,
  override: ConfigProxy,
  scopedDeltas: ReadonlyMap<string, ConfigProxy>,
): GitLayerDocument | undefined {
  const base = effective(origin, override);
  if (base === undefined) return undefined;
  const baseRecord = asRecord(base);
  const scopes: Record<string, JsonValue> = {};
  for (const [appId, delta] of scopedDeltas) {
    const read = delta.read();
    if (!read) continue;
    scopes[appId] = { ...baseRecord, ...asRecord(read.content) };
  }
  return { base, scopes };
}

/**
 * A committed layer's raw files, already read, addressed by the one layout
 * (`configFileRelPath`): the checkout's `config/` on the desktop, the bundled
 * copy of it in a browser host. A lookup, never a disk read — so resolving a
 * document ({@link committedDocument}) holds no thread on any host; whoever
 * builds one reads the files first ({@link committedFilesFromMap} over what it
 * read, {@link readCommittedFilesSync} for a tool process).
 */
export interface CommittedFiles {
  /** One file's text, or `null` when the layer has no such file. */
  read(ref: ConfigFileRef): string | null;
  /** The app ids with an `@app/<id>` directory under `storePath`'s hierarchy. */
  appIds(storePath: string): string[];
}

function committedProxy(
  files: CommittedFiles,
  ref: ConfigFileRef,
): ConfigProxy {
  const where = configFileRelPath(ref);
  return {
    read() {
      const raw = files.read(ref);
      return raw === null ? null : parseConfigFile(raw, where);
    },
    write() {
      throw new Error(`The committed config layer is read-only: ${where}`);
    },
    exists: () => files.read(ref) !== null,
  };
}

/**
 * One descriptor's committed document, resolved through {@link resolveGitLayer}
 * over a layer's raw files — every file parsed strictly (a hashless committed
 * file throws, naming it). `undefined` when the layer has neither an origin nor
 * an override at `storePath`.
 */
export function committedDocument(
  storePath: string,
  files: CommittedFiles,
): GitLayerDocument | undefined {
  const scoped = new Map<string, ConfigProxy>();
  for (const appId of files.appIds(storePath)) {
    scoped.set(
      appId,
      committedProxy(files, {
        storePath,
        scopeId: appScopeId(appId),
        file: "override",
      }),
    );
  }
  return resolveGitLayer(
    committedProxy(files, { storePath, file: "origin" }),
    committedProxy(files, { storePath, file: "override" }),
    scoped,
  );
}

/**
 * A committed layer held as a map of layer-relative path → text (a bundle of
 * `config/`). Every key must be a config file path (`parseConfigFileRelPath`
 * throws otherwise); the map is indexed once.
 */
export function committedFilesFromMap(
  files: ReadonlyMap<string, string>,
): CommittedFiles {
  const appIdsByHier = new Map<string, Set<string>>();
  for (const rel of files.keys()) {
    const ref = parseConfigFileRelPath(rel);
    const appId = scopeAppId(ref.scopeId);
    if (appId === undefined) continue;
    const hier = hierOf(ref.storePath);
    let ids = appIdsByHier.get(hier);
    if (ids === undefined) appIdsByHier.set(hier, (ids = new Set()));
    ids.add(appId);
  }
  return {
    read: (ref) => files.get(configFileRelPath(ref)) ?? null,
    appIds: (storePath) =>
      [...(appIdsByHier.get(hierOf(storePath)) ?? [])].sort(),
  };
}

function hierOf(storePath: string): string {
  return storePath.slice(0, Math.max(0, storePath.lastIndexOf("/")));
}

/** The synchronous fs calls {@link readCommittedFilesSync} reads a directory with. */
export interface CommittedFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(
    path: string,
    opts: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
}

/** A config file's name in a committed dir: every layer file is JSONC. */
const CONFIG_FILE = /\.jsonc$/;

/**
 * A committed config dir on disk (`dir`, absolute — the checkout's `config/`, or
 * a release's vendored copy), read whole, once: every `*.jsonc` under it, keyed
 * by its layer-relative path. The fs is handed in, so this core module stays
 * host-free. The disk reader of the tool processes that resolve many documents
 * in one pass (the build's propagation, the plugin-move ledger); a backend
 * reads the files a document needs without holding its thread and hands them
 * to {@link committedFilesFromMap} (`config_v2#machine`'s repo layer).
 */
export function readCommittedFilesSync(
  dir: string,
  fs: CommittedFs,
): CommittedFiles {
  const files = new Map<string, string>();
  const walkSync = (rel: string): void => {
    const abs = rel === "" ? dir : `${dir}/${rel}`;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walkSync(child);
      else if (CONFIG_FILE.test(entry.name))
        files.set(child, fs.readFileSync(`${dir}/${child}`, "utf8"));
    }
  };
  if (fs.existsSync(dir)) walkSync("");
  return committedFilesFromMap(files);
}

/**
 * Propagate one committed document into a user layer — THE propagation, run by
 * the desktop build (`propagateConfigToUser`, over files) and by a memory store
 * seeding itself (over memory), so the two cannot disagree: the base becomes the
 * user origin (`propagate`, capturing the merge base into the ancestor at the
 * conflict transition), and each committed `@app/<id>` scope becomes that
 * scope's user origin. Returns the documents whose user override was written
 * against a different upstream (a conflict the caller reports).
 */
export function propagateGitLayerDocument(
  storePath: string,
  doc: GitLayerDocument,
  proxyOf: (ref: ConfigFileRef) => ConfigProxy,
): { conflicts: ConfigDocRef[] } {
  const conflicts: ConfigDocRef[] = [];
  const base = { storePath };
  if (
    propagate(
      readonlyProxy(doc.base),
      proxyOf({ ...base, file: "origin" }),
      proxyOf({ ...base, file: "override" }),
      proxyOf({ ...base, file: "ancestor" }),
    ).conflict
  ) {
    conflicts.push(base);
  }
  for (const [appId, scoped] of Object.entries(doc.scopes)) {
    const ref = { storePath, scopeId: appScopeId(appId) };
    if (
      propagate(
        readonlyProxy(scoped),
        proxyOf({ ...ref, file: "origin" }),
        proxyOf({ ...ref, file: "override" }),
      ).conflict
    ) {
      conflicts.push(ref);
    }
  }
  return { conflicts };
}
