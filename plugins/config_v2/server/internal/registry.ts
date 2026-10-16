import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import type { ConfigDescriptor, ConfigValues } from "../../core";
import { configRawFile } from "../../core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import type { FieldsRecord, InferFieldValue } from "@plugins/fields/core";
import {
  computeHash,
  hasConflict,
  normalizeCollectionItems,
  readTypedConfig,
  threeWayMerge,
} from "../../core";
import { jsoncConfigProxy, writeRawAtomic } from "./jsonc-proxy";
import type { Disposable, JsonValue } from "../../core";
import {
  userScopedDir,
  discoverScopeIds,
  scopeSegment,
  BASE_SCOPE,
} from "./scope-paths";
import { configWatcherArmed, watchFileChange } from "./config-watcher";
import { ConfigV2 } from "./contribution";
import {
  configConflictServed,
  configRegistryReady,
  configTiersServed,
  configValuesServed,
  getDescriptorByStorePath,
  getHierarchyPath,
  markRegistryReady,
  refreshConflictLocations,
  refreshModifiedCount,
  refreshScopeMembers,
  registerDescriptorPath,
  scopeHasOwnConfig,
  setConfigGetter,
} from "./resource";
import { getFieldStorageProvider } from "./field-storage-providers";
import { configDocumentsAgree } from "./field-tiers";
import { writeScopedOriginSnapshot } from "./scope-snapshot";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { REPO_ROOT, repoConfigDir } from "@plugins/infra/plugins/paths/server";
import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import { CONFIG_DIR } from "./config-dir";
import {
  defineAgentWriteLedger,
  type AgentWriteLedgerEntry,
  type FileSnapshot,
} from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/server";
import {
  configLedgerDocument,
  configLedgerKey,
  type ConfigDocumentFile,
} from "./config-ledger-key";

interface CacheEntry {
  scopeId: string;
  values: ConfigValues<FieldsRecord>;
  storePath: string;
  userOriginPath: string;
  userOverwritesPath: string;
  userAncestorPath: string;
  disposables: Disposable[];
}

/**
 * Options every config WRITE takes. `writer` is required on purpose.
 *
 * It replaces what used to be a trailing optional `scopeId`, rather than being
 * appended after it: an added 5th positional parameter would compile while
 * forcing every caller to restate `scopeId`, and a `writer` with a default
 * would let a new handler silently record its agent writes as user writes. As
 * an options object, omitting `writer` — or omitting the object — is a `tsc`
 * error, and the positional-`scopeId` footgun goes away at the same time.
 *
 * Named `writer`, NOT `origin`: in config_v2 "origin" already means the
 * `.origin.jsonc` layer (the same collision that made descriptors carry
 * `source`).
 */
export interface ConfigWriteOpts {
  /** `originOf(req)` at an HTTP boundary; `systemOrigin("…")` otherwise. */
  writer: WriteOrigin;
  scopeId?: string;
}

/**
 * The config documents an agent-origin request overwrote, held so the e2e
 * harness can put them back — config's ledger in the shared agent-write ledger
 * primitive. Design:
 * `research/2026-08-30-global-agent-config-write-revert-ledger.md`.
 *
 * Defined HERE, beside the write paths, because its `restore` is
 * `applyRestore` below, which needs `refreshEntry` / `getEntry` /
 * `ensureScopeEntry` / `disposeScopeEntry` — all module-private to this file.
 * `scope-fork.ts` records through the same handle.
 */
export const configWriteLedger = defineAgentWriteLedger<ConfigDocumentFile>({
  id: "config",
  label: "Config documents",
  restore: applyRestore,
});

/** The trio of files a document is made of, for the agent-write ledger. */
function trioPathsOf(entry: CacheEntry): Record<ConfigDocumentFile, string> {
  return {
    origin: entry.userOriginPath,
    override: entry.userOverwritesPath,
    ancestor: entry.userAncestorPath,
  };
}

/**
 * Snapshot this document before an agent-origin write touches it. A no-op for
 * every other writer. Call immediately BEFORE the file mutation.
 */
function recordWrite(
  opts: ConfigWriteOpts,
  entry: CacheEntry,
  operation: string,
): void {
  configWriteLedger.record(
    opts.writer,
    configLedgerKey(entry.storePath, entry.scopeId),
    trioPathsOf(entry),
    operation,
  );
}

/** Refresh the ledger's "what the agent left" snapshot, after the write lands. */
function noteWrite(opts: ConfigWriteOpts, entry: CacheEntry): void {
  configWriteLedger.noteComplete(
    opts.writer,
    configLedgerKey(entry.storePath, entry.scopeId),
  );
}

// 2D cache keyed by (descriptor × scopeId). Inner key "" (BASE_SCOPE) is the base
// (global) entry; "app:<id>" keys are lazily-created scoped entries.
const cacheByDescriptor = new WeakMap<
  ConfigDescriptor,
  Map<string, CacheEntry>
>();
const subscribersByDescriptor = new WeakMap<
  ConfigDescriptor,
  Map<string, Set<(values: ConfigValues<FieldsRecord>) => void>>
>();

// All app scopeIds we currently know about — populated when a fork happens and
// whenever a scoped entry is lazily built. Used so a BASE file change can notify
// every currently-un-forked scope (apps tracking base must re-render).
const knownScopeIds = new Set<string>();

// Resolve one entry's values straight off disk (origin ⊕ override, schema-typed,
// collections normalized). Provider-backed fields are layered on by the caller —
// they live outside the JSONC document.
function readEntryValues(
  descriptor: ConfigDescriptor,
  userOriginPath: string,
  userOverwritesPath: string,
): ConfigValues<FieldsRecord> {
  const raw = readTypedConfig(
    descriptor,
    jsoncConfigProxy(userOriginPath),
    jsoncConfigProxy(userOverwritesPath),
  );
  return normalizeCollectionItems(
    raw as Record<string, unknown>,
    descriptor.fields,
  ) as ConfigValues<FieldsRecord>;
}

/**
 * THE single "this entry's files changed" path: re-read from disk, replace the
 * cached values, and fan out every derived notification.
 *
 * Called from BOTH ends, and that pairing is the invariant:
 *   - the file watcher, for out-of-band writes (build propagation, hand edits);
 *   - every in-process writer, immediately after its own write.
 *
 * The second is not redundant. The watcher is a **push-latency** mechanism, not a
 * correctness one — its own contract (config-watcher.ts) says an event can be
 * missed (a dropped fsevent, an unobserved writer, a coalesced rename) and that
 * nothing downstream may treat "no event" as "no change". A writer that relied on
 * its own event coming back would, on a missed event, leave `entry.values` stale
 * forever: the write is correctly on disk, but `getConfig` — and with it the
 * config-v2.values push AND the boot snapshot every page load hydrates from —
 * keeps serving the pre-write document, so the edit silently "reverts" on refresh.
 * Refreshing in-process makes a write observable by construction; a duplicate
 * watcher event afterwards is a cheap idempotent re-read.
 */
function refreshEntry(descriptor: ConfigDescriptor, entry: CacheEntry): void {
  const freshValues = readEntryValues(
    descriptor,
    entry.userOriginPath,
    entry.userOverwritesPath,
  );

  // Provider-backed (e.g. secret) fields are stored outside the JSONC document,
  // so a disk re-read has nothing to say about them — carry the loaded value
  // forward rather than resetting it to the field default.
  for (const [key, field] of Object.entries(descriptor.fields)) {
    if (!getFieldStorageProvider(field.type.id)) continue;
    (freshValues as Record<string, unknown>)[key] = (
      entry.values as Record<string, unknown>
    )[key];
  }

  entry.values = freshValues;

  const subs = subscribersByDescriptor.get(descriptor)?.get(entry.scopeId);
  if (subs) {
    for (const cb of subs) cb(freshValues);
  }

  // A scoped origin/override file appearing or disappearing changes the
  // descriptor's customized-scope set, which the config-v2.scopes resource
  // publishes.
  if (entry.scopeId) refreshScopeMembers(entry.storePath);

  notifyDocument(entry.storePath, entry.scopeId);
}

// Build a fully-wired cache entry for (descriptor, scopeId): scoped paths,
// initial values, field-storage-provider load loop, and file watchers. Mirrors the
// base-entry construction in initRegistry — the only difference is the scope path
// segment threaded through userScopedDir. Returns the entry (also stored in cache).
async function buildEntry(
  descriptor: ConfigDescriptor,
  hierarchyPath: string,
  storePath: string,
  scopeId: string,
): Promise<CacheEntry> {
  const scopedDir = userScopedDir(hierarchyPath, scopeId || undefined);
  const userOriginPath = join(scopedDir, `${descriptor.name}.origin.jsonc`);
  const userOverwritesPath = join(scopedDir, `${descriptor.name}.jsonc`);
  const userAncestorPath = join(scopedDir, `${descriptor.name}.ancestor.jsonc`);

  const values = readEntryValues(
    descriptor,
    userOriginPath,
    userOverwritesPath,
  );

  for (const [key, field] of Object.entries(descriptor.fields)) {
    const provider = getFieldStorageProvider(field.type.id);
    if (provider) {
      try {
        const result = await provider.load(descriptor.name, key);
        (values as Record<string, unknown>)[key] = result.value;
      } catch (err) {
        if (err instanceof Error && err.name === "SecretsMainOfflineError") {
          // Provider unavailable — keep JSONC default
        } else {
          throw err;
        }
      }
    }
  }

  const disposables: Disposable[] = [];

  const entry: CacheEntry = {
    scopeId,
    values,
    storePath,
    userOriginPath,
    userOverwritesPath,
    userAncestorPath,
    disposables,
  };

  // Watch both files for OUT-OF-BAND writes. In-process writers refresh this same
  // entry themselves (see refreshEntry) rather than waiting on these events.
  const onFileChange = () => refreshEntry(descriptor, entry);
  disposables.push(watchFileChange(userOverwritesPath, onFileChange));
  disposables.push(watchFileChange(userOriginPath, onFileChange));

  let scopeMap = cacheByDescriptor.get(descriptor);
  if (!scopeMap) {
    scopeMap = new Map();
    cacheByDescriptor.set(descriptor, scopeMap);
  }
  scopeMap.set(scopeId, entry);

  if (scopeId) knownScopeIds.add(scopeId);

  return entry;
}

// The git-layer files of one document. Git-layer files live in the repo, not
// the per-worktree user dir. A scoped override is expressed in git at
// config/<dir>/@app/<id>/<name>.jsonc, but its origin anchor is always the BASE
// origin (config/<dir>/<name>.origin.jsonc) — no scoped origin is ever
// committed. So the override path takes the scope segment while the origin path
// stays base.
function gitLayerPaths(
  storePath: string,
  scopeId: string | undefined,
): { gitOverridePath: string; gitOriginPath: string } {
  const parts = storePath.replace(/\.jsonc$/, "").split("/");
  const dir = parts.slice(0, -1).join("/");
  const name = parts[parts.length - 1]!;
  return {
    gitOverridePath: join(
      repoConfigDir(),
      dir,
      scopeSegment(scopeId),
      `${name}.jsonc`,
    ),
    gitOriginPath: join(repoConfigDir(), dir, `${name}.origin.jsonc`),
  };
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

/**
 * Watch the git layer of one document for as long as its raw text is read: the
 * repo's config tree, filtered to the document's two git files. Nothing else
 * signals them — a build propagates them into the user layer (which
 * `notifyDocument` covers), but the raw view shows them before that build.
 */
async function watchGitLayer(
  storePath: string,
  scopeId: string | undefined,
  notify: () => void,
): Promise<() => void> {
  const { gitOverridePath, gitOriginPath } = gitLayerPaths(storePath, scopeId);
  const release = await acquireDirWatch({
    dir: repoConfigDir(),
    scope: "subtree",
    onChange: (events) => {
      if (
        events.some(
          (e) => e.path === gitOverridePath || e.path === gitOriginPath,
        )
      )
        notify();
    },
  });
  // A write between the first load and either watch opening (this git-layer
  // one, or the user-layer config-files watcher armed in `onReady`) produced
  // no event; one re-read once both are live closes that gap.
  try {
    await configWatcherArmed();
  } catch (err) {
    release();
    throw err;
  }
  notify();
  return release;
}

/**
 * The raw text of one document's four layered files (`config-v2.raw-file`).
 *
 * `notified`, from both halves of its truth: the user-layer override and origin
 * are the cache entry's own files, so the registry's one document fan-out
 * (`notifyDocument`, run by `refreshEntry` on every watcher event and every
 * in-process write) moves this value with the document, its conflicts and its
 * tiers; the git layer is watched while subscribed (`watchGitLayer`).
 *
 * Paths are returned relative to their layer root (user config dir / repo root)
 * so the UI can label each section with a compact, non-wrapping location rather
 * than a noisy absolute path. The label already names the layer.
 */
export const configRawFileServed = serveValue(configRawFile, {
  source: "external",
  changes: "notified",
  loader: async ({ path, scopeId }) => {
    await configRegistryReady();
    const descriptor = getDescriptorByStorePath(path);
    if (!descriptor) {
      throw configRawFile.refuse("missing", `No descriptor for "${path}"`);
    }
    const entry = getEntry(descriptor, scopeId ?? BASE_SCOPE);
    if (!entry) {
      throw configRawFile.refuse(
        "missing",
        `No config document for "${path}"${scopeId ? ` in scope "${scopeId}"` : ""}`,
      );
    }
    const { gitOverridePath, gitOriginPath } = gitLayerPaths(path, scopeId);
    return {
      override: readRaw(entry.userOverwritesPath),
      overridePath: relative(CONFIG_DIR, entry.userOverwritesPath),
      origin: readRaw(entry.userOriginPath),
      originPath: relative(CONFIG_DIR, entry.userOriginPath),
      gitOverride: readRaw(gitOverridePath),
      gitOverridePath: relative(REPO_ROOT, gitOverridePath),
      gitOrigin: readRaw(gitOriginPath),
      gitOriginPath: relative(REPO_ROOT, gitOriginPath),
    };
  },
  whileSubscribed: ({ path, scopeId }, notify) =>
    watchGitLayer(path, scopeId, notify),
});

// The per-document live values: each keyed `{ path, scopeId? }`, each a
// function of the same file trio, so each moves whenever the document does.
const perDocument = [
  configValuesServed,
  configConflictServed,
  configTiersServed,
  configRawFileServed,
];

// THE document fan-out for a (storePath, scopeId) change — the one call every
// writer makes after its write (the three per-document values used to be
// notified by three copies of this loop). It derives the tuples the change
// moved ONCE — a scoped change its own tuple; a BASE change the base tuple plus
// every known scope with no config of its own (it resolves base live) — and
// notifies each per-document value for each, so no writer can move the
// document and forget its conflicts or tiers. The two aggregates are refreshed
// here too — each diffs what it last published and notifies only on a flip.
function notifyDocument(storePath: string, scopeId: string): void {
  // Modified-count is computed off effective BASE values for this descriptor, so
  // recompute just this path (scope-independent).
  refreshModifiedCount(storePath);
  const tuples: { path: string; scopeId?: string }[] = [];
  if (scopeId) {
    tuples.push({ path: storePath, scopeId });
  } else {
    tuples.push({ path: storePath });
    const descriptor = getDescriptorByStorePath(storePath);
    for (const sid of knownScopeIds) {
      if (descriptor && scopeHasOwnConfig(descriptor, sid)) continue;
      tuples.push({ path: storePath, scopeId: sid });
    }
  }
  for (const served of perDocument) {
    for (const tuple of tuples) served.notify(tuple);
  }
  // A latency optimization only: conflict-locations re-derives from disk on
  // every load.
  refreshConflictLocations(storePath);
}

// Fan out every read-resource notify for a (storePath, scopeId) change in one
// call. Used by the per-descriptor fork/remove primitives, whose file writes
// must surface immediately (rather than waiting on the debounced watcher), and
// which also change the descriptor's customized-scope set. Mirrors the fan-out
// the watcher's onFileChange performs.
export function notifyDescriptorScopeChange(
  storePath: string,
  scopeId: string,
): void {
  refreshScopeMembers(storePath);
  notifyDocument(storePath, scopeId);
}

function getEntry(
  descriptor: ConfigDescriptor,
  scopeId: string = BASE_SCOPE,
): CacheEntry | undefined {
  return cacheByDescriptor.get(descriptor)?.get(scopeId);
}

// Lazily build (and cache) a scoped entry for (descriptor, scopeId). The base
// entry is created in initRegistry; scoped entries don't exist until a fork writes
// files, so callers that need to write a scoped override go through here first.
export async function ensureScopeEntry(
  descriptor: ConfigDescriptor,
  scopeId: string,
): Promise<CacheEntry> {
  const existing = getEntry(descriptor, scopeId);
  if (existing) return existing;

  const hierarchyPath = getHierarchyPath(descriptor);
  if (!hierarchyPath) {
    throw new Error(
      `[config-v2] ensureScopeEntry: descriptor "${descriptor.name}" has no registered hierarchy path.`,
    );
  }
  const storePath = `${hierarchyPath}/${descriptor.name}.jsonc`;
  return buildEntry(descriptor, hierarchyPath, storePath, scopeId);
}

export async function initRegistry(): Promise<void> {
  try {
    setConfigGetter(getConfig);
    const contributions = ConfigV2.Register.getContributions();
    const registered: {
      descriptor: ConfigDescriptor;
      hierarchyPath: string;
    }[] = [];

    for (const contribution of contributions) {
      const { descriptor } = contribution;
      // An explicit `pluginId` lets a plugin register a descriptor under a
      // *different* plugin's config tree; default to the registering plugin's own id.
      // Both are the canonical DOT-form PluginId. The on-disk store layout is slash
      // (`config/<slash>/`), so convert dot→slash here at the single boundary — the
      // resulting `hierarchyPath` value flows unchanged through every downstream
      // reader (registerDescriptorPath, getHierarchyPath, userScopedDir, scope-fork).
      const pluginId = contribution.pluginId ?? contribution._pluginId;
      if (!pluginId) {
        console.warn(
          `[config-v2] contribution for descriptor "${descriptor.name}" has no _pluginId — skipping`,
        );
        continue;
      }
      const hierarchyPath = asPath(asPluginId(pluginId));

      const storePath = `${hierarchyPath}/${descriptor.name}.jsonc`;
      registerDescriptorPath(storePath, descriptor, hierarchyPath);

      // Register only the BASE entry per descriptor (as today). Scoped entries are
      // created on demand by ensureScopeEntry once a fork writes their files.
      await buildEntry(descriptor, hierarchyPath, storePath, BASE_SCOPE);
      registered.push({ descriptor, hierarchyPath });
    }

    // Rehydrate scoped entries from disk. Scoped (per-app) entries are otherwise
    // only ever created lazily on fork/setConfig, so after a server restart none
    // exist — yet their files persist on disk (a propagated git scope's origin, or
    // a runtime fork's override). Without this the in-memory cache silently
    // disagrees with durable state: getConfig (which needs a live entry AND the
    // on-disk scope) falls back to base/global for an app with its own config, and
    // knownScopeIds stays empty so base-config changes stop notifying scoped apps.
    // Any registered descriptor can be git-scoped (a committed config/<hier>/@app/
    // file), not just `scope: "app"` ones — so iterate the full registered set.
    for (const { descriptor, hierarchyPath } of registered) {
      for (const scopeId of discoverScopeIds(hierarchyPath)) {
        if (scopeHasOwnConfig(descriptor, scopeId)) {
          await ensureScopeEntry(descriptor, scopeId);
        }
      }
    }

    // Warm the derived state behind the aggregate resources: the scopes and
    // modified-counts maps their loaders read (so a first load is a memory read,
    // not a filesystem walk), and — for conflict-locations, whose loader re-derives
    // from disk — the fingerprint memo plus the published-set snapshot, so the
    // first load is stat-only and the first real change doesn't emit a spurious
    // notify.
    for (const { descriptor, hierarchyPath } of registered) {
      const storePath = `${hierarchyPath}/${descriptor.name}.jsonc`;
      refreshScopeMembers(storePath);
      refreshConflictLocations(storePath);
      refreshModifiedCount(storePath);
    }
  } finally {
    // Open the readiness gate even if init threw partway through. Otherwise the
    // resource loader awaits registryReady forever and every config read hangs
    // app-wide on a loading spinner with no error surfaced. With the gate open,
    // already-registered descriptors resolve normally and any unregistered path
    // hits the loader's clear per-path throw (loud client error, not a hang).
    // The original error still propagates out of initRegistry (awaited in
    // onReady), so the boot failure remains loudly logged server-side.
    markRegistryReady();
  }
}

export function shutdownRegistry(): void {
  const contributions = ConfigV2.Register.getContributions();
  for (const contribution of contributions) {
    const { descriptor } = contribution;
    const scopeMap = cacheByDescriptor.get(descriptor);
    if (scopeMap) {
      for (const entry of scopeMap.values()) {
        for (const d of entry.disposables) d.dispose();
      }
      cacheByDescriptor.delete(descriptor);
    }
    subscribersByDescriptor.delete(descriptor);
  }
  knownScopeIds.clear();
}

// Dispose the watchers for a scoped entry and drop it from the cache. Used by
// deleteScope when un-forking — base entries are never disposed here.
export function disposeScopeEntry(
  descriptor: ConfigDescriptor,
  scopeId: string,
): void {
  if (!scopeId) return;
  const scopeMap = cacheByDescriptor.get(descriptor);
  const entry = scopeMap?.get(scopeId);
  if (entry) {
    for (const d of entry.disposables) d.dispose();
    scopeMap!.delete(scopeId);
  }
  subscribersByDescriptor.get(descriptor)?.delete(scopeId);
}

export function getConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  scopeId: string = BASE_SCOPE,
): ConfigValues<F> {
  const base = getEntry(descriptor, BASE_SCOPE);
  if (!base) {
    throw new Error(
      `[config-v2] getConfig: descriptor "${descriptor.name}" is not registered or onReady has not completed.`,
    );
  }
  if (!scopeId) return base.values as ConfigValues<F>;

  // Scoped read: a scope with its own config (a propagated git scope OR a runtime
  // fork) returns its own values; an untracked scope tracks base LIVE.
  const scoped = getEntry(descriptor, scopeId);
  if (scoped && scopeHasOwnConfig(descriptor, scopeId)) {
    return scoped.values as ConfigValues<F>;
  }
  return base.values as ConfigValues<F>;
}

export async function setConfig<
  F extends FieldsRecord,
  K extends keyof F & string,
>(
  descriptor: ConfigDescriptor<F>,
  key: K,
  value: InferFieldValue<F[K]>,
  opts: ConfigWriteOpts,
): Promise<void> {
  const scopeId = opts.scopeId ?? BASE_SCOPE;
  const entry = scopeId
    ? await ensureScopeEntry(descriptor, scopeId)
    : getEntry(descriptor, BASE_SCOPE);
  if (!entry) {
    throw new Error(
      `[config-v2] setConfig: descriptor "${descriptor.name}" is not registered or onReady has not completed.`,
    );
  }

  descriptor.fields[key]!.schema.parse(value);

  const provider = getFieldStorageProvider(descriptor.fields[key]!.type.id);
  if (provider) {
    (entry.values as Record<string, unknown>)[key] = value;
    await provider.save(descriptor.name, key, value as string);
    const subs = subscribersByDescriptor.get(descriptor)?.get(entry.scopeId);
    if (subs) {
      for (const cb of subs) cb(entry.values);
    }
    notifyDocument(entry.storePath, entry.scopeId);
    return;
  }

  const userOverwrites = jsoncConfigProxy(entry.userOverwritesPath);
  const userOrigin = jsoncConfigProxy(entry.userOriginPath);

  // For a scoped write, fork-on-write keys off the BASE origin (the only thing we
  // can snapshot from). Read it off the base CacheEntry's userOriginPath — the
  // authoritative base-origin location for this descriptor.
  const baseOriginPath = getEntry(descriptor, BASE_SCOPE)?.userOriginPath;

  let base: Record<string, unknown>;
  let hash: string | null;

  if (userOverwrites.exists()) {
    const ow = userOverwrites.read()!;
    base = { ...(ow.content as Record<string, unknown>) };
    hash = ow.hash;
  } else if (userOrigin.exists()) {
    const orig = userOrigin.read()!;
    base = { ...(orig.content as Record<string, unknown>) };
    hash = computeHash(orig.content);
  } else if (
    scopeId &&
    baseOriginPath &&
    jsoncConfigProxy(baseOriginPath).exists()
  ) {
    // FORK-ON-WRITE. The scope has no own config (neither scoped override nor
    // scoped origin), but the BASE origin exists — so this is a first scoped
    // write to an app that tracks base. Rather than throwing, auto-create the
    // scope by snapshotting base-effective values into the scoped origin (the
    // exact snapshot forkDescriptor writes, via the shared buildScopeSnapshot
    // helper), then fall through to the normal write path below: userOrigin now
    // exists, so the override is anchored against the freshly-written scoped
    // origin's hash. This makes a scoped write make the scope exist *and*
    // readable — fully symmetric with the read path, no fork ceremony.
    const hierarchyPath = getHierarchyPath(descriptor);
    if (!hierarchyPath) {
      throw new Error(
        `[config-v2] setConfig: descriptor "${descriptor.name}" has no registered hierarchy path.`,
      );
    }
    writeScopedOriginSnapshot(descriptor, hierarchyPath, scopeId);
    // Surface the scope-membership flip promptly (the config-v2.scopes resource)
    // rather than waiting on the ~100ms watcher debounce — mirrors
    // forkDescriptorScope. The override write below is picked up by the entry's
    // own watcher as today.
    notifyDescriptorScopeChange(entry.storePath, scopeId);
    const orig = userOrigin.read()!;
    base = { ...(orig.content as Record<string, unknown>) };
    hash = computeHash(orig.content);
  } else {
    // ./singularity build propagates a hashed origin for every registered
    // descriptor, so a missing origin here means the build never ran (or the
    // file was deleted). A base write with no origin — or a scoped write when
    // even the BASE origin is absent (the fork-on-write branch above can't fire,
    // since there is no base to snapshot) — both land here. Writing a hashless
    // override to paper over it would produce a corrupt file that conflict
    // detection can't anchor — fail loudly.
    throw new Error(
      `[config-v2] setConfig: no origin file for "${entry.storePath}" at ${entry.userOriginPath}. ` +
        `Run ./singularity build to propagate the config origin before setting overrides.`,
    );
  }

  recordWrite(opts, entry, `set-field:${key}`);
  base[key] = value;
  const normalized = normalizeCollectionItems(base, descriptor.fields);
  userOverwrites.write(normalized as JsonValue, hash);
  refreshEntry(descriptor, entry);
  noteWrite(opts, entry);
}

export async function setConfigByPath(
  storePath: string,
  key: string,
  value: unknown,
  opts: ConfigWriteOpts,
): Promise<void> {
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) throw new Error(`No descriptor for "${storePath}"`);
  // `opts` forwarded whole, never destructured and rebuilt — that is what stops
  // the writer being dropped in the middle of the call chain.
  await setConfig(
    descriptor,
    key as keyof typeof descriptor.fields & string,
    value as never,
    opts,
  );
}

export async function resetConfigByPath(
  storePath: string,
  key: string,
  opts: ConfigWriteOpts,
): Promise<void> {
  const scopeId = opts.scopeId;
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) throw new Error(`No descriptor for "${storePath}"`);

  const field = descriptor.fields[key];
  if (!field) throw new Error(`No field "${key}" in "${descriptor.name}"`);

  const provider = getFieldStorageProvider(field.type.id);
  if (provider) {
    // KNOWN LIMIT, stated rather than papered over: a provider-backed (secret)
    // field never touches the JSONC layer, so a bytes ledger cannot capture it
    // and an agent write here is NOT revertible. Covering it would need a
    // second, provider-side ledger. See the design doc's "known limits".
    await provider.clear(descriptor.name, key);
    const entry = getEntry(descriptor, scopeId ?? BASE_SCOPE);
    if (entry) {
      (entry.values as Record<string, unknown>)[key] = field.defaultValue;
      const subs = subscribersByDescriptor.get(descriptor)?.get(entry.scopeId);
      if (subs) {
        for (const cb of subs) cb(entry.values);
      }
      notifyDocument(entry.storePath, entry.scopeId);
    }
    return;
  }

  // RESET RESTORES WHAT THE REPO COMMITS, not what the code declares.
  //
  // The git layer (the generated origin ⊕ any committed authored override) is
  // what `./singularity build` propagated into this entry's origin file, and it
  // is the baseline the settings pane calls "unmodified". Writing
  // `descriptor.defaults[key]` instead used to leave the field still marked as
  // modified — and for a reorder slot it wiped the committed arrangement to an
  // empty list, because a build-materialized descriptor's declared default is
  // `[]` while its origin is the live contribution catalog.
  const entry = getEntry(descriptor, scopeId ?? BASE_SCOPE);
  if (!entry) throw new Error(`No cache entry for "${storePath}"`);

  const originProxy = jsoncConfigProxy(entry.userOriginPath);
  const originData = originProxy.read();
  if (!originData) {
    // Symmetric with setConfig: every registered descriptor gets a propagated
    // origin, so a missing one means the build never ran. There is no baseline
    // to restore, and inventing one from the code defaults is what this fix
    // removed.
    throw new Error(
      `[config-v2] resetConfigField: no origin file for "${storePath}" at ${entry.userOriginPath}. ` +
        `Run ./singularity build to propagate the config origin before resetting fields.`,
    );
  }
  const originDoc = asDocument(originData.content);

  // A key the origin does not carry — the field was added since the last build,
  // or the origin was hand-truncated. `setConfig` parses the value against the
  // field schema, so passing `undefined` through would throw and leave Reset a
  // dead button; the code default is the only baseline left in that case.
  const resetValue =
    key in originDoc
      ? originDoc[key]
      : (descriptor.defaults as Record<string, unknown>)[key];

  // Would this reset leave the user layer saying nothing the git layer doesn't
  // already say? Then remove the user layer rather than writing a copy of the
  // origin into it — a phantom override becomes a stale-hash conflict banner the
  // next time the git layer moves, for a user who changed nothing.
  //
  // NOT while a conflict is open: deleting the override there is "Accept new
  // defaults", a terminal resolution the banner owns, and it takes the ancestor
  // (the three-way merge base) with it. A per-field Reset must not do that
  // behind the user's back.
  const overwrites = jsoncConfigProxy(entry.userOverwritesPath);
  if (overwrites.exists() && !hasConflict(originProxy, overwrites)) {
    const current = asDocument(overwrites.read()?.content ?? null);
    const next = normalizeCollectionItems(
      { ...current, [key]: resetValue },
      descriptor.fields,
    );
    if (configDocumentsAgree(next, originDoc, descriptor.fields)) {
      recordWrite(opts, entry, `reset-field:${key}`);
      unlinkSync(entry.userOverwritesPath);
      if (existsSync(entry.userAncestorPath))
        unlinkSync(entry.userAncestorPath);
      refreshEntry(descriptor, entry);
      noteWrite(opts, entry);
      return;
    }
  }

  await setConfig(
    descriptor,
    key as keyof typeof descriptor.fields & string,
    resetValue as never,
    opts,
  );
}

function asDocument(content: JsonValue | null): Record<string, unknown> {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  return {};
}

export function watchConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  cb: (values: ConfigValues<F>) => void,
  scopeId: string = BASE_SCOPE,
): Disposable {
  const entry = getEntry(descriptor, scopeId);
  if (!entry) {
    throw new Error(
      `[config-v2] watchConfig: descriptor "${descriptor.name}" (scope "${scopeId}") is not registered or onReady has not completed.`,
    );
  }

  let scopeSubs = subscribersByDescriptor.get(descriptor);
  if (!scopeSubs) {
    scopeSubs = new Map();
    subscribersByDescriptor.set(descriptor, scopeSubs);
  }
  let subs = scopeSubs.get(scopeId);
  if (!subs) {
    subs = new Set();
    scopeSubs.set(scopeId, subs);
  }

  const wrappedCb = cb as (values: ConfigValues<FieldsRecord>) => void;
  subs.add(wrappedCb);

  cb(entry.values as ConfigValues<F>);

  return {
    dispose: () => {
      subs!.delete(wrappedCb);
    },
  };
}

export function acknowledgeConflictByPath(
  storePath: string,
  opts: ConfigWriteOpts,
): void {
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) throw new Error(`No descriptor for "${storePath}"`);

  const entry = getEntry(descriptor, opts.scopeId ?? BASE_SCOPE);
  if (!entry) throw new Error(`No cache entry for "${storePath}"`);

  const userOverwrites = jsoncConfigProxy(entry.userOverwritesPath);
  const userOrigin = jsoncConfigProxy(entry.userOriginPath);

  if (!userOverwrites.exists())
    throw new Error(`No override file for "${storePath}"`);
  const ow = userOverwrites.read();
  if (!ow) throw new Error(`Cannot read override for "${storePath}"`);

  const originData = userOrigin.read();
  if (!originData) throw new Error(`Cannot read origin for "${storePath}"`);

  const newHash = computeHash(originData.content);
  recordWrite(opts, entry, "acknowledge-conflict");
  userOverwrites.write(ow.content, newHash);
  // Terminal resolution — the override now wins against the current origin, so
  // the merge base is no longer needed. A stale ancestor would seed a wrong
  // three-way merge on the next conflict.
  if (existsSync(entry.userAncestorPath)) unlinkSync(entry.userAncestorPath);
  // The override just flipped from ignored (stale) to winning — the resolved
  // value changed even though no file content did.
  refreshEntry(descriptor, entry);
  noteWrite(opts, entry);
}

// Three-way merge resolution: reconcile a stale override against its origin
// using the ancestor snapshot propagate() captured. Fields only one side changed
// are auto-resolved; fields both sides changed differently are returned in
// `conflictKeys` (left as the user's value, tentatively). When nothing truly
// conflicts the override is rewritten against the current origin (resolved) and
// the ancestor dropped; otherwise the stale hash is kept so the conflict stays
// surfaced and re-running merge after the user resolves the remaining fields
// finalizes it (idempotent — the same conflictKeys recur until resolved).
export function mergeConflictByPath(
  storePath: string,
  opts: ConfigWriteOpts,
): { resolved: boolean; conflictKeys: string[] } {
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) throw new Error(`No descriptor for "${storePath}"`);

  const entry = getEntry(descriptor, opts.scopeId ?? BASE_SCOPE);
  if (!entry) throw new Error(`No cache entry for "${storePath}"`);

  const userOverwrites = jsoncConfigProxy(entry.userOverwritesPath);
  const userOrigin = jsoncConfigProxy(entry.userOriginPath);
  const userAncestor = jsoncConfigProxy(entry.userAncestorPath);

  if (!userAncestor.exists()) {
    throw new Error(
      `No ancestor snapshot for "${storePath}" — three-way merge unavailable`,
    );
  }
  const ow = userOverwrites.read();
  if (!ow) throw new Error(`Cannot read override for "${storePath}"`);
  const originData = userOrigin.read();
  if (!originData) throw new Error(`Cannot read origin for "${storePath}"`);
  const base = userAncestor.read();
  if (!base) throw new Error(`Cannot read ancestor for "${storePath}"`);

  const { merged, conflicts } = threeWayMerge(
    base.content as Record<string, JsonValue>,
    ow.content as Record<string, JsonValue>,
    originData.content as Record<string, JsonValue>,
  );
  const normalized = normalizeCollectionItems(merged, descriptor.fields);

  const resolved = conflicts.length === 0;
  const hash = resolved ? computeHash(originData.content) : ow.hash;
  recordWrite(opts, entry, "merge-conflict");
  userOverwrites.write(normalized as JsonValue, hash);
  if (resolved && existsSync(entry.userAncestorPath))
    unlinkSync(entry.userAncestorPath);
  refreshEntry(descriptor, entry);
  noteWrite(opts, entry);

  return { resolved, conflictKeys: conflicts };
}

export function deleteOverrideByPath(
  storePath: string,
  opts: ConfigWriteOpts,
): void {
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) throw new Error(`No descriptor for "${storePath}"`);

  const entry = getEntry(descriptor, opts.scopeId ?? BASE_SCOPE);
  if (!entry) throw new Error(`No cache entry for "${storePath}"`);

  recordWrite(opts, entry, "delete-override");
  // Idempotent: an "invalid" conflict can surface with no override on disk
  // (the origin itself fails the current schema). Deleting a non-existent
  // override is a no-op — defaults are already in effect.
  if (existsSync(entry.userOverwritesPath))
    unlinkSync(entry.userOverwritesPath);
  // The override is gone, so any captured merge base is moot — drop it.
  if (existsSync(entry.userAncestorPath)) unlinkSync(entry.userAncestorPath);
  refreshEntry(descriptor, entry);
  noteWrite(opts, entry);
}

/** Put one captured file back: exact bytes, or gone if it did not exist. */
function restoreFile(path: string, snapshot: FileSnapshot): void {
  if (snapshot.present) {
    writeRawAtomic(path, snapshot.bytes);
    return;
  }
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Restore one ledgered document's files and re-sync the cache.
 *
 * The cache half is why the revert goes through the server at all rather than
 * the harness rewriting files itself: `CONFIG_DIR`'s watcher is a push-latency
 * mechanism, not a correctness one (an event can be missed), so a filesystem
 * restore behind the server's back could leave `getConfig`, the
 * `config-v2.values` push and every subscribed browser serving the agent's
 * value indefinitely. Going through `refreshEntry` / `ensureScopeEntry` makes
 * the update deterministic.
 *
 * The ledger's `restore` for {@link configWriteLedger}; it has already checked
 * that no file moved since the agent's last write.
 */
async function applyRestore(
  entry: AgentWriteLedgerEntry<ConfigDocumentFile>,
): Promise<void> {
  restoreFile(entry.paths.origin, entry.before.origin);
  restoreFile(entry.paths.override, entry.before.override);
  restoreFile(entry.paths.ancestor, entry.before.ancestor);

  const { storePath, scopeId } = configLedgerDocument(entry.key);
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) {
    // Renamed or removed between the run and the revert. The bytes are back,
    // which is the user-visible fact; there is no cache entry left to re-sync.
    // Not an error — throwing here would strand a correctly-restored document
    // in the ledger forever.
    return;
  }

  if (!scopeId) {
    const base = getEntry(descriptor, BASE_SCOPE);
    if (base) refreshEntry(descriptor, base);
    return;
  }

  // A scoped document's entry is BUILT FROM the files, so a restore that
  // created or destroyed them changes whether the entry should exist at all.
  // Rebuild rather than refresh — the same dispose/ensure pair forkDescriptor
  // and removeDescriptor use, so a reverted fork lands in the cache state those
  // functions would have produced.
  disposeScopeEntry(descriptor, scopeId);
  const stillExists =
    existsSync(entry.paths.origin) || existsSync(entry.paths.override);
  if (stillExists) await ensureScopeEntry(descriptor, scopeId);
  notifyDescriptorScopeChange(storePath, scopeId);
}
