import { parseConfigFile } from "./config-file";
import { readonlyProxy, type ConfigProxy } from "./config-proxy";
import { APP_SCOPE_DIR, appScopeId, scopeAppId } from "./scope-format";
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
 * A committed layer's raw files, addressed by the one layout
 * (`configFileRelPath`): the checkout's `config/` on the desktop, the bundled
 * copy of it in a browser host.
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

/**
 * The checkout's two committed config roots, repo-relative.
 *
 * - `config/` is the SHIPPING layer: the code defaults (`.origin.jsonc`) and the
 *   overrides every install gets — authored layouts, views, app themes. A browser
 *   host bundles it, a release vendors it.
 * - `owner-config/` is the OWNER's layer: values that are this instance's owner's
 *   own (their prompt templates, preprompts, categories), committed so every
 *   worktree of the checkout reads them, but never shipped. Override files only —
 *   the origin is always `config/`'s, and each owner file's `// @hash` is anchored
 *   to it.
 */
export const SHIPPING_CONFIG_DIR = "config";
export const OWNER_CONFIG_DIR = "owner-config";

/**
 * Which committed root a repo-relative path sits in, and its path inside it
 * (the layer-relative path `configFileRelPath` spells) — `null` outside both.
 * The one spelling of "is this a committed config file, and of whose layer", for
 * every repo walker (checks, the plugin-ref locator).
 */
export function committedLayerOf(
  repoRelPath: string,
): { layer: "shipping" | "owner"; rel: string } | null {
  for (const [layer, dir] of [
    ["shipping", SHIPPING_CONFIG_DIR],
    ["owner", OWNER_CONFIG_DIR],
  ] as const) {
    if (repoRelPath.startsWith(`${dir}/`))
      return { layer, rel: repoRelPath.slice(dir.length + 1) };
  }
  return null;
}

/**
 * A checkout's committed layer: the shipping layer with the owner's on top. An
 * owner override replaces the shipping one (overrides are whole documents);
 * origins are the shipping layer's alone; a scope committed in either is a scope.
 * Read by the desktop and its build — never by a browser host, which only has
 * `config/`.
 */
export function withOwnerLayer(
  shipping: CommittedFiles,
  owner: CommittedFiles,
): CommittedFiles {
  return {
    read: (ref) =>
      ref.file === "override"
        ? (owner.read(ref) ?? shipping.read(ref))
        : shipping.read(ref),
    appIds: (storePath) =>
      [
        ...new Set([...shipping.appIds(storePath), ...owner.appIds(storePath)]),
      ].sort(),
  };
}

/** The synchronous fs calls {@link committedFilesIn} reads a directory with. */
export interface CommittedFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(
    path: string,
    opts: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
}

/**
 * One committed root on disk (`dir`, absolute) as raw files, read per call. The fs
 * is handed in, so this core module stays host-free; an absent `dir` is a layer
 * holding nothing (a checkout without an owner layer).
 */
export function committedFilesIn(dir: string, fs: CommittedFs): CommittedFiles {
  return {
    read(ref) {
      const file = `${dir}/${configFileRelPath(ref)}`;
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    },
    appIds(storePath) {
      const hier = hierOf(storePath);
      const appDir = `${dir}/${hier === "" ? "" : `${hier}/`}${APP_SCOPE_DIR}`;
      if (!fs.existsSync(appDir)) return [];
      return fs
        .readdirSync(appDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    },
  };
}

/**
 * The committed layer of the checkout at `root`: `config/` with `owner-config/`
 * on top ({@link withOwnerLayer}) — or, with `ownerLayer: false`, the shipping
 * layer alone (what a release ships to someone else).
 */
export function checkoutCommittedFiles(
  root: string,
  fs: CommittedFs,
  opts: { ownerLayer: boolean },
): CommittedFiles {
  const shipping = committedFilesIn(`${root}/${SHIPPING_CONFIG_DIR}`, fs);
  return opts.ownerLayer
    ? withOwnerLayer(
        shipping,
        committedFilesIn(`${root}/${OWNER_CONFIG_DIR}`, fs),
      )
    : shipping;
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
