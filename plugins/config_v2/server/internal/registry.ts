import type {
  ConfigDescriptor,
  ConfigDocRef,
  ConfigDocumentFile,
  ConfigFileRef,
  ConfigValues,
} from "../../core";
import type { FieldsRecord, InferFieldValue } from "@plugins/fields/core";
import {
  computeHash,
  configFileRelPath,
  hasConflict,
  loadedProxy,
  normalizeCollectionItems,
  readTypedConfig,
  threeWayMerge,
} from "../../core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { diffValue } from "@plugins/packages/plugins/value-patch/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import type { Disposable, JsonValue } from "../../core";
import { BASE_SCOPE, documentFiles } from "./scope-paths";
import { ConfigStore } from "./host-services";
import { documentStamp } from "./document-stamp";
import { ConfigV2 } from "./contribution";
import {
  configConflictServed,
  configTiersServed,
  configValuesServed,
  getDescriptorByStorePath,
  getHierarchyPath,
  markRegistryReady,
  refreshConflictLocations,
  refreshModifiedCount,
  refreshScopeMembers,
  registerDescriptorPath,
  scopeHasOwnConfigOnDisk,
  setConfigGetter,
} from "./resource";
import { getFieldStorageProvider } from "./field-storage-providers";
import { configDocumentsAgree } from "./field-tiers";
import { writeScopedOriginSnapshot } from "./scope-snapshot";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  systemOrigin,
  type WriteOrigin,
} from "@plugins/infra/plugins/request-origin/core";

interface CacheEntry {
  scopeId: string;
  values: ConfigValues<FieldsRecord>;
  /**
   * Whether the document had a file of its own (origin or override) when
   * `values` was last read — the scope-membership answer that goes with the
   * values, read in the same pass (a base entry's is never consulted).
   */
  ownConfig: boolean;
  storePath: string;
  /** The document's files in the user-layer store (`ConfigStore`). */
  files: Record<ConfigDocumentFile, ConfigFileRef>;
  /** `documentStamp(files)` as of the read `values` came from. */
  stamp: string;
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
 * A field write. `fromOverride`: the value was computed from the user's override
 * document (the settings conflict editor binds to it), not from the value the
 * app shows — the only write a document in conflict accepts.
 */
export interface SetConfigOpts extends ConfigWriteOpts {
  fromOverride?: true;
}

/** The document a cache entry holds, as the store addresses it. */
function docOf(entry: CacheEntry): ConfigDocRef {
  return { storePath: entry.storePath, scopeId: entry.scopeId };
}

/**
 * Run one write to an entry's files through the store's `edit` — the one
 * spelling of a registry write, so a store that ledgers agent-origin writes
 * (the desktop's: the agent-write ledger, so the e2e harness can put them back;
 * `research/2026-08-30-global-agent-config-write-revert-ledger.md`) captures
 * the document's whole trio before the mutation and what it left after.
 * `mutate` writes the files and refreshes the entry.
 */
function editEntry(
  opts: ConfigWriteOpts,
  entry: CacheEntry,
  operation: string,
  mutate: () => Promise<void>,
): Promise<void> {
  return ConfigStore.get().edit(docOf(entry), opts.writer, operation, mutate);
}

// One document's reads-then-writes run one at a time. The store's I/O is
// asynchronous, so without this two writers of one document (or a writer and
// a watcher-driven re-read) could interleave: both read the override, both
// write their own key — the first write lost — or a re-read that started
// before a write could replace the cache with the pre-write document after
// the write's own refresh. Keyed per document; never re-entered (a locked
// section calls the unlocked helpers, e.g. `refreshEntryNow`).
const documentLock = createKeyedMutex();

/** Run `fn` holding the document's lock (`storePath`, `scopeId`). */
export function withDocument<T>(
  storePath: string,
  scopeId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return documentLock.run(`${storePath}\0${scopeId ?? BASE_SCOPE}`, fn);
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

// Resolve one entry's values straight off the store (origin ⊕ override,
// schema-typed, collections normalized), and whether the document has a file
// of its own. Provider-backed fields are layered on by the caller — they live
// outside the JSONC document.
//
// An override written by hand without a `// @hash` header (a person or an agent
// editing the user layer directly) is STAMPED here with the hash of the origin
// beside it — the origin it was written against: nothing but the build moves an
// origin, and the build stamps such a file itself before it does (`propagate`).
// The hash is derived, never asked of the writer, so a hand-written override is
// applied as soon as it lands and joins the conflict chain like one `setConfig`
// wrote — a later origin change surfaces Keep / Accept / Merge rather than the
// file winning forever. `stamped` says the read wrote it, so the caller re-takes
// the trio's stamp. With no origin there is nothing to stamp against: the
// override stands alone, as it would anyway, until the build propagates one.
// Runs in the document's lock (or at boot, before any writer).
async function readEntryValues(
  descriptor: ConfigDescriptor,
  doc: ConfigDocRef,
  files: Record<ConfigDocumentFile, ConfigFileRef>,
): Promise<{
  values: ConfigValues<FieldsRecord>;
  ownConfig: boolean;
  stamped: boolean;
}> {
  const store = ConfigStore.get();
  const [origin, read] = await Promise.all([
    store.read(files.origin),
    store.read(files.override),
  ]);
  let override = read;
  let stamped = false;
  // Not one that does not parse (`syntaxErrors`): it is surfaced as invalid,
  // and rewriting it would replace the author's text with the parser's salvage.
  if (
    override !== null &&
    override.hash === null &&
    override.syntaxErrors === undefined &&
    origin !== null
  ) {
    const stampedOverride = {
      content: override.content,
      hash: computeHash(origin.content),
    };
    await store.edit(doc, STAMP_WRITER, "stamp-unstamped-override", () =>
      store.write(
        files.override,
        stampedOverride.content,
        stampedOverride.hash,
      ),
    );
    override = stampedOverride;
    stamped = true;
  }
  const raw = readTypedConfig(
    descriptor,
    loadedProxy(origin),
    loadedProxy(override),
  );
  return {
    values: normalizeCollectionItems(
      raw as Record<string, unknown>,
      descriptor.fields,
    ) as ConfigValues<FieldsRecord>,
    ownConfig: origin !== null || override !== null,
    stamped,
  };
}

/** Who stamps an unstamped override: the registry itself, never the request. */
const STAMP_WRITER = systemOrigin("config-v2.stamp-unstamped-override");

/**
 * THE single "this entry's files changed" path: re-read from the store, replace the
 * cached values, and fan out every derived notification.
 *
 * Called from BOTH ends, and that pairing is the invariant:
 *   - the file watcher, for out-of-band writes (build propagation, hand edits);
 *   - every in-process writer, immediately after its own write.
 *
 * The second is not redundant. The watcher is a **push-latency** mechanism, not a
 * correctness one — the store's `watch` contract (on the desktop, the machine
 * half's config-watcher.ts) says an event can be missed (a dropped fsevent, an
 * unobserved writer, a coalesced rename) and that nothing downstream may treat
 * "no event" as "no change". A writer that relied on
 * its own event coming back would, on a missed event, leave `entry.values` stale
 * forever: the write is correctly on disk, but `getConfig` — and with it the
 * config-v2.values push AND the boot snapshot every page load hydrates from —
 * keeps serving the pre-write document, so the edit silently "reverts" on refresh.
 * Refreshing in-process makes a write observable by construction; a duplicate
 * watcher event afterwards is a cheap idempotent re-read.
 */
//
// Runs inside the document's lock (`withDocument`): a writer calls it from its
// own locked section, the watcher through `refreshEntry`.
async function refreshEntryNow(
  descriptor: ConfigDescriptor,
  entry: CacheEntry,
): Promise<void> {
  // Stamped BEFORE the read: a write landing between the two moves the stamp
  // again, so the next refresh re-reads it. An unchanged trio changed nothing
  // the document's values, conflicts or tiers are a function of — the watcher
  // event for a write this process already refreshed, a touch that rewrote
  // nothing — so it notifies nothing.
  let stamp = await documentStamp(entry.files);
  if (stamp === entry.stamp) return;
  const {
    values: freshValues,
    ownConfig,
    stamped,
  } = await readEntryValues(descriptor, docOf(entry), entry.files);
  // Its own write moved the trio: the stamp is the one after it.
  if (stamped) stamp = await documentStamp(entry.files);
  // Only a read that succeeded answers for the stamp: a document that fails
  // to parse is read (and fails) again on the next refresh.
  entry.stamp = stamp;

  // Provider-backed (e.g. secret) fields are stored outside the JSONC document,
  // so a disk re-read has nothing to say about them — carry the loaded value
  // forward rather than resetting it to the field default.
  for (const [key, field] of Object.entries(descriptor.fields)) {
    if (!getFieldStorageProvider(field.type.id)) continue;
    (freshValues as Record<string, unknown>)[key] = (
      entry.values as Record<string, unknown>
    )[key];
  }

  // The stamp says a FILE moved; the values are what readers hold. A rewrite of
  // the same bytes, a comment or a reformat, an override restating its origin
  // moves the stamp and resolves to the same document — no values tuple and no
  // in-process subscriber moved (a base document's base-tracking scopes resolve
  // through it, so they did not either). Conflicts, tiers and the raw file are
  // functions of the files themselves, so they still follow the stamp.
  const valuesMoved =
    ownConfig !== entry.ownConfig ||
    diffValue(entry.values, freshValues)?.length !== 0;
  entry.values = freshValues;
  entry.ownConfig = ownConfig;

  if (valuesMoved) {
    const subs = subscribersByDescriptor.get(descriptor)?.get(entry.scopeId);
    if (subs) {
      for (const cb of subs) cb(freshValues);
    }
  }

  // A scoped origin/override file appearing or disappearing changes the
  // descriptor's customized-scope set, which the config-v2.scopes resource
  // publishes.
  if (entry.scopeId) await refreshScopeMembers(entry.storePath);

  await notifyDocument(entry.storePath, entry.scopeId, { valuesMoved });
}

/** `refreshEntryNow` taking the document's lock — for a caller outside one. */
function refreshEntry(
  descriptor: ConfigDescriptor,
  entry: CacheEntry,
): Promise<void> {
  return withDocument(entry.storePath, entry.scopeId, () =>
    refreshEntryNow(descriptor, entry),
  );
}

// Build a fully-wired cache entry for (descriptor, scopeId): the document's
// files, initial values, field-storage-provider load loop, and the store watch.
// The base entry and every scoped entry are built here alike — the only
// difference is the scope. Returns the entry (also stored in cache).
async function buildEntry(
  descriptor: ConfigDescriptor,
  storePath: string,
  scopeId: string,
): Promise<CacheEntry> {
  const files = documentFiles({ storePath, scopeId });
  let stamp = await documentStamp(files);
  const { values, ownConfig, stamped } = await readEntryValues(
    descriptor,
    { storePath, scopeId },
    files,
  );
  if (stamped) stamp = await documentStamp(files);

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
    ownConfig,
    storePath,
    files,
    stamp,
    disposables,
  };

  // Watch the document for OUT-OF-BAND writes. In-process writers refresh this
  // same entry themselves (see refreshEntry) rather than waiting on these events.
  // The watch's callback cannot await: the re-read runs on its own, and a
  // failure surfaces as an unhandled rejection rather than being dropped.
  disposables.push(
    ConfigStore.get().watch({ storePath, scopeId }, () => {
      void runTracked("config-v2:refresh-on-watch", () =>
        refreshEntry(descriptor, entry),
      );
    }),
  );

  let scopeMap = cacheByDescriptor.get(descriptor);
  if (!scopeMap) {
    scopeMap = new Map();
    cacheByDescriptor.set(descriptor, scopeMap);
  }
  scopeMap.set(scopeId, entry);

  if (scopeId) knownScopeIds.add(scopeId);

  return entry;
}

// The per-document live values: each keyed `{ path, scopeId? }`, each a
// function of the same file trio, so each moves whenever the document does.
const perDocument = [
  configValuesServed,
  configConflictServed,
  configTiersServed,
];

/** One document a change moved, as the per-document live values key it. */
export interface ConfigDocumentTuple {
  path: string;
  scopeId?: string;
}

const documentListeners = new Set<(doc: ConfigDocumentTuple) => void>();

/**
 * Hear every document tuple the registry's one fan-out moves — the same tuples
 * the per-document live values are notified for (a base change also moves each
 * known scope with no config of its own). For a value served outside this
 * plugin's server half that is a function of the same document (the desktop's
 * raw-file view), so it moves with the document, its conflicts and its tiers.
 * Returns the unsubscribe.
 */
export function onDocumentChange(
  listener: (doc: ConfigDocumentTuple) => void,
): () => void {
  documentListeners.add(listener);
  return () => {
    documentListeners.delete(listener);
  };
}

// THE document fan-out for a (storePath, scopeId) change — the one call every
// writer makes after its write (the three per-document values used to be
// notified by three copies of this loop). It derives the tuples the change
// moved ONCE — a scoped change its own tuple; a BASE change the base tuple plus
// every known scope with no config of its own (it resolves base live) — and
// notifies each per-document value for each, so no writer can move the
// document and forget its conflicts or tiers. The two aggregates are refreshed
// here too — each diffs what it last published and notifies only on a flip.
async function notifyDocument(
  storePath: string,
  scopeId: string,
  // False when the files moved but the resolved values did not
  // (`refreshEntryNow`): `config-v2.values` is skipped, the rest still move.
  { valuesMoved = true }: { valuesMoved?: boolean } = {},
): Promise<void> {
  // Modified-count is computed off effective BASE values for this descriptor, so
  // recompute just this path (scope-independent).
  await refreshModifiedCount(storePath);
  const tuples: ConfigDocumentTuple[] = [];
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
    if (served === configValuesServed && !valuesMoved) continue;
    for (const tuple of tuples) served.notify(tuple);
  }
  for (const listener of [...documentListeners]) {
    for (const tuple of tuples) listener(tuple);
  }
  // A latency optimization only: conflict-locations re-derives from disk on
  // every load.
  await refreshConflictLocations(storePath);
}

// Fan out every read-resource notify for a (storePath, scopeId) change in one
// call. Used by the per-descriptor fork/remove primitives, whose file writes
// must surface immediately (rather than waiting on the debounced watcher), and
// which also change the descriptor's customized-scope set. Mirrors the fan-out
// the watcher's onFileChange performs.
export async function notifyDescriptorScopeChange(
  storePath: string,
  scopeId: string,
): Promise<void> {
  await refreshScopeMembers(storePath);
  await notifyDocument(storePath, scopeId);
}

function getEntry(
  descriptor: ConfigDescriptor,
  scopeId: string = BASE_SCOPE,
): CacheEntry | undefined {
  return cacheByDescriptor.get(descriptor)?.get(scopeId);
}

// Whether a scope resolves to its own document: its entry is loaded and, at
// its last read, had a scoped origin (a propagated git scope) or a scoped
// override (a runtime fork) — `scopeHasOwnConfigOnDisk`'s predicate, read off
// the same pass as the entry's values, so the membership and the values a read
// returns always come from one read of the files. Synchronous because
// `getConfig` is; every write refreshes the entry, as does every watcher event.
function scopeHasOwnConfig(
  descriptor: ConfigDescriptor,
  scopeId: string,
): boolean {
  if (!scopeId) return false;
  return getEntry(descriptor, scopeId)?.ownConfig === true;
}

/**
 * Whether the registry holds the document (`storePath`, `scopeId`) — a
 * registered descriptor's base, or a scope with a document of its own loaded.
 */
export function hasConfigDocument(
  storePath: string,
  scopeId: string = BASE_SCOPE,
): boolean {
  const descriptor = getDescriptorByStorePath(storePath);
  return (
    descriptor !== undefined && getEntry(descriptor, scopeId) !== undefined
  );
}

// Lazily build (and cache) a scoped entry for (descriptor, scopeId). The base
// entry is created in initRegistry; scoped entries don't exist until a fork writes
// files, so callers that need to write a scoped override go through here first.
//
// Builds under the document's lock and re-checks inside it, so two callers
// racing to create one scope build one entry (and one watch).
export async function ensureScopeEntry(
  descriptor: ConfigDescriptor,
  scopeId: string,
): Promise<CacheEntry> {
  const existing = getEntry(descriptor, scopeId);
  if (existing) return existing;
  const storePath = descriptorStorePath(descriptor, "ensureScopeEntry");
  return withDocument(storePath, scopeId, () =>
    ensureScopeEntryNow(descriptor, storePath, scopeId),
  );
}

/** `ensureScopeEntry` inside the document's lock. */
async function ensureScopeEntryNow(
  descriptor: ConfigDescriptor,
  storePath: string,
  scopeId: string,
): Promise<CacheEntry> {
  return (
    getEntry(descriptor, scopeId) ??
    (await buildEntry(descriptor, storePath, scopeId))
  );
}

function descriptorStorePath(
  descriptor: ConfigDescriptor,
  caller: string,
): string {
  const hierarchyPath = getHierarchyPath(descriptor);
  if (!hierarchyPath) {
    throw new Error(
      `[config-v2] ${caller}: descriptor "${descriptor.name}" has no registered hierarchy path.`,
    );
  }
  return `${hierarchyPath}/${descriptor.name}.jsonc`;
}

/**
 * Bring a scope's entry in line with files a fork just wrote: refresh it when
 * it is loaded (it may predate them — built for a write, before the scope had
 * a document), build it otherwise. Runs inside the document's lock.
 */
export async function syncScopeEntryNow(
  descriptor: ConfigDescriptor,
  scopeId: string,
): Promise<void> {
  const existing = getEntry(descriptor, scopeId);
  if (existing) await refreshEntryNow(descriptor, existing);
  else
    await buildEntry(
      descriptor,
      descriptorStorePath(descriptor, "syncScopeEntryNow"),
      scopeId,
    );
}

/**
 * How many descriptors `initRegistry` reads at once: each holds a handful of
 * file reads and stats in flight, so a few dozen keep the disk busy without
 * opening hundreds of files together.
 */
const INIT_CONCURRENCY = 16;

export async function initRegistry(): Promise<void> {
  try {
    setConfigGetter(getConfig);
    const contributions = ConfigV2.Register.getContributions();
    const registered: {
      descriptor: ConfigDescriptor;
      storePath: string;
    }[] = [];

    for (const contribution of contributions) {
      const { descriptor } = contribution;
      // An explicit `pluginId` lets a plugin register a descriptor under a
      // *different* plugin's config tree; default to the registering plugin's own id.
      // Both are the canonical DOT-form PluginId. The on-disk store layout is slash
      // (`config/<slash>/`), so convert dot→slash here at the single boundary — the
      // resulting `hierarchyPath` value flows unchanged through every downstream
      // reader (registerDescriptorPath, getHierarchyPath, the store, scope-fork).
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
      registered.push({ descriptor, storePath });
    }

    // Each descriptor's documents are read on their own: its base entry, then
    // every scoped entry its store holds, then its scope membership — and the
    // ~250 descriptors at once, a bounded number in flight. Read one after
    // another, every one of the ~1.5k file reads and stats waited for the
    // previous one: 3.5 s of a busy host's boot before the backend could serve,
    // for ~0.8 s of work.
    //
    // Scoped (per-app) entries are otherwise only ever created lazily on
    // fork/setConfig, so after a server restart none exist — yet their files
    // persist on disk (a propagated git scope's origin, or a runtime fork's
    // override). Without rehydrating them the in-memory cache silently
    // disagrees with durable state: getConfig (which needs a live entry AND the
    // on-disk scope) falls back to base/global for an app with its own config,
    // and knownScopeIds stays empty so base-config changes stop notifying
    // scoped apps. Any registered descriptor can be git-scoped (a committed
    // config/<hier>/@app/ file), not just `scope: "app"` ones — so every
    // registered descriptor is asked.
    //
    // The scopes map is warmed because `config-v2.scopes` is preloaded and its
    // loader reads it. The conflict-locations and modified-counts sweeps are
    // NOT warmed here: their loaders derive from disk themselves, nothing
    // preloads them, and only the config nav reads them — so the first nav
    // open pays for them, not every boot.
    const store = ConfigStore.get();
    const reads = createSemaphore(INIT_CONCURRENCY);
    await Promise.all(
      registered.map(({ descriptor, storePath }) =>
        reads.run(async () => {
          await buildEntry(descriptor, storePath, BASE_SCOPE);
          for (const scopeId of await store.scopes(storePath)) {
            if (await scopeHasOwnConfigOnDisk(descriptor, scopeId)) {
              await ensureScopeEntry(descriptor, scopeId);
            }
          }
          await refreshScopeMembers(storePath);
        }),
      ),
    );
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
  opts: SetConfigOpts,
): Promise<void> {
  const scopeId = opts.scopeId ?? BASE_SCOPE;
  // The base entry is never dropped, so it can be read outside the lock; a
  // scoped one can be (Stop customizing), so it is resolved under the lock.
  const base = getEntry(descriptor, BASE_SCOPE);
  if (!base) {
    throw new Error(
      `[config-v2] setConfig: descriptor "${descriptor.name}" is not registered or onReady has not completed.`,
    );
  }

  descriptor.fields[key]!.schema.parse(value);

  const provider = getFieldStorageProvider(descriptor.fields[key]!.type.id);
  if (provider) {
    const entry = scopeId ? await ensureScopeEntry(descriptor, scopeId) : base;
    (entry.values as Record<string, unknown>)[key] = value;
    await provider.save(descriptor.name, key, value as string);
    const subs = subscribersByDescriptor.get(descriptor)?.get(entry.scopeId);
    if (subs) {
      for (const cb of subs) cb(entry.values);
    }
    await notifyDocument(entry.storePath, entry.scopeId);
    return;
  }

  // Resolve the entry INSIDE the lock: a `removeDescriptorScope` holding it
  // drops the scope's entry, and a write queued behind it must not land on
  // that dropped entry (it would re-fork the scope on disk with no live entry
  // or watch behind it). A scope with no entry is built afresh — exactly a
  // first write to a scope that never had one (fork-on-write).
  await withDocument(base.storePath, scopeId, async () => {
    const entry = scopeId
      ? await ensureScopeEntryNow(descriptor, base.storePath, scopeId)
      : base;
    await writeField(descriptor, entry, key, value, opts);
  });
}

// setConfig's file write, inside the document's lock: read the override (or
// origin) the write is based on, write the whole document back, refresh.
async function writeField(
  descriptor: ConfigDescriptor,
  entry: CacheEntry,
  key: string,
  value: unknown,
  opts: SetConfigOpts,
): Promise<void> {
  const scopeId = entry.scopeId;
  const store = ConfigStore.get();
  const [overrideData, originData] = await Promise.all([
    store.read(entry.files.override),
    store.read(entry.files.origin),
  ]);
  const userOverwrites = loadedProxy(overrideData);
  let userOrigin = loadedProxy(originData);

  // For a scoped write, fork-on-write keys off the BASE origin (the only thing we
  // can snapshot from). Read it off the base CacheEntry's origin — the
  // authoritative base-origin location for this descriptor.
  const baseOrigin = getEntry(descriptor, BASE_SCOPE)?.files.origin;

  let base: Record<string, unknown>;
  let hash: string | null;

  if (userOverwrites.exists()) {
    // REFUSED WHILE IN CONFLICT. The app resolves to the new origin while the
    // user's own values sit parked in the override, so a writer computing its
    // value from what the app shows would replace the parked value of `key`
    // with the new default's — and a whole list is one key (a DataView's
    // `views`: one option toggled rewrote every saved view as the defaults).
    // Only a write computed from the override itself (the settings conflict
    // editor) may land; every other waits for Keep / Accept / Merge.
    if (!opts.fromOverride && hasConflict(userOrigin, userOverwrites)) {
      throw new Error(
        `[config-v2] "${entry.storePath}"${opts.scopeId ? ` (${opts.scopeId})` : ""} has a conflict — resolve it in Settings → Config first.`,
      );
    }
    const ow = userOverwrites.read()!;
    base = { ...(ow.content as Record<string, unknown>) };
    hash = ow.hash;
  } else if (userOrigin.exists()) {
    const orig = userOrigin.read()!;
    base = { ...(orig.content as Record<string, unknown>) };
    hash = computeHash(orig.content);
  } else if (scopeId && baseOrigin && (await store.read(baseOrigin)) !== null) {
    // FORK-ON-WRITE. The scope has no own config (neither scoped override nor
    // scoped origin), but the BASE origin exists — so this is a first scoped
    // write to an app that tracks base. Rather than throwing, auto-create the
    // scope by snapshotting base-effective values into the scoped origin (the
    // exact snapshot forkDescriptor writes, via the shared buildScopeSnapshot
    // helper), then fall through to the normal write path below: userOrigin now
    // exists, so the override is anchored against the freshly-written scoped
    // origin's hash. This makes a scoped write make the scope exist *and*
    // readable — fully symmetric with the read path, no fork ceremony.
    await writeScopedOriginSnapshot(descriptor, entry.storePath, scopeId);
    // Re-read the entry now its scope has a document: its membership flips
    // (the config-v2.scopes resource) and getConfig resolves the scope's own
    // values, promptly rather than on the ~100ms watcher debounce — mirrors
    // forkDescriptorScope.
    await refreshEntryNow(descriptor, entry);
    userOrigin = loadedProxy(await store.read(entry.files.origin));
    const orig = userOrigin.read()!;
    base = { ...(orig.content as Record<string, unknown>) };
    hash = computeHash(orig.content);
  } else {
    // ./equin build propagates a hashed origin for every registered
    // descriptor, so a missing origin here means the build never ran (or the
    // file was deleted). A base write with no origin — or a scoped write when
    // even the BASE origin is absent (the fork-on-write branch above can't fire,
    // since there is no base to snapshot) — both land here. Writing a hashless
    // override to paper over it would produce a corrupt file that conflict
    // detection can't anchor — fail loudly.
    throw new Error(
      `[config-v2] setConfig: no origin file for "${entry.storePath}" at ${configFileRelPath(entry.files.origin)}. ` +
        `Run ./equin build to propagate the config origin before setting overrides.`,
    );
  }

  base[key] = value;
  const normalized = normalizeCollectionItems(base, descriptor.fields);
  await editEntry(opts, entry, `set-field:${key}`, async () => {
    await store.write(entry.files.override, normalized as JsonValue, hash);
    await refreshEntryNow(descriptor, entry);
  });
}

export async function setConfigByPath(
  storePath: string,
  key: string,
  value: unknown,
  opts: SetConfigOpts,
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
      await notifyDocument(entry.storePath, entry.scopeId);
    }
    return;
  }

  // RESET RESTORES WHAT THE REPO COMMITS, not what the code declares.
  //
  // The git layer (the generated origin ⊕ any committed authored override) is
  // what `./equin build` propagated into this entry's origin file, and it
  // is the baseline the settings pane calls "unmodified". Writing
  // `descriptor.defaults[key]` instead used to leave the field still marked as
  // modified — and for a reorder slot it wiped the committed arrangement to an
  // empty list, because a build-materialized descriptor's declared default is
  // `[]` while its origin is the live contribution catalog.
  const resetValue = await withWriteTarget(storePath, opts, (_, entry) =>
    resetFieldFiles(descriptor, entry, key, opts),
  );
  // The reset removed the user layer: nothing left to write.
  if (resetValue.kind === "removed") return;

  // Outside the lock: setConfig takes it itself, and re-reads the document.
  await setConfig(
    descriptor,
    key as keyof typeof descriptor.fields & string,
    resetValue.value as never,
    opts,
  );
}

// resetConfigByPath's file half, inside the document's lock: what the field
// resets to, and — when that leaves the user layer saying nothing the origin
// does not — the user layer removed.
async function resetFieldFiles(
  descriptor: ConfigDescriptor,
  entry: CacheEntry,
  key: string,
  opts: ConfigWriteOpts,
): Promise<{ kind: "removed" } | { kind: "set"; value: unknown }> {
  const storePath = entry.storePath;
  const store = ConfigStore.get();
  const [originData, overrideData] = await Promise.all([
    store.read(entry.files.origin),
    store.read(entry.files.override),
  ]);
  const originProxy = loadedProxy(originData);
  if (!originData) {
    // Symmetric with setConfig: every registered descriptor gets a propagated
    // origin, so a missing one means the build never ran. There is no baseline
    // to restore, and inventing one from the code defaults is what this fix
    // removed.
    throw new Error(
      `[config-v2] resetConfigField: no origin file for "${storePath}" at ${configFileRelPath(entry.files.origin)}. ` +
        `Run ./equin build to propagate the config origin before resetting fields.`,
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
  const overwrites = loadedProxy(overrideData);
  if (overwrites.exists() && !hasConflict(originProxy, overwrites)) {
    const current = asDocument(overwrites.read()?.content ?? null);
    const next = normalizeCollectionItems(
      { ...current, [key]: resetValue },
      descriptor.fields,
    );
    if (configDocumentsAgree(next, originDoc, descriptor.fields)) {
      await editEntry(opts, entry, `reset-field:${key}`, async () => {
        await store.remove(entry.files.override);
        await store.remove(entry.files.ancestor);
        await refreshEntryNow(descriptor, entry);
      });
      return { kind: "removed" };
    }
  }
  return { kind: "set", value: resetValue };
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

/**
 * Run `fn` holding the document's lock, over the registered descriptor and the
 * loaded entry a by-path write targets — the entry looked up INSIDE the lock, so
 * a scope dropped by a `removeDescriptorScope` that held it is refused rather
 * than written through a stale, unwatched entry.
 */
async function withWriteTarget<T>(
  storePath: string,
  opts: ConfigWriteOpts,
  fn: (descriptor: ConfigDescriptor, entry: CacheEntry) => Promise<T>,
): Promise<T> {
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) throw new Error(`No descriptor for "${storePath}"`);
  const scopeId = opts.scopeId ?? BASE_SCOPE;
  return withDocument(storePath, scopeId, async () => {
    const entry = getEntry(descriptor, scopeId);
    if (!entry) throw new Error(`No cache entry for "${storePath}"`);
    return await fn(descriptor, entry);
  });
}

export async function acknowledgeConflictByPath(
  storePath: string,
  opts: ConfigWriteOpts,
): Promise<void> {
  await withWriteTarget(storePath, opts, async (descriptor, entry) => {
    const store = ConfigStore.get();
    const [ow, originData] = await Promise.all([
      store.read(entry.files.override),
      store.read(entry.files.origin),
    ]);
    if (!ow) throw new Error(`No override file for "${storePath}"`);
    if (!originData) throw new Error(`Cannot read origin for "${storePath}"`);

    const newHash = computeHash(originData.content);
    await editEntry(opts, entry, "acknowledge-conflict", async () => {
      await store.write(entry.files.override, ow.content, newHash);
      // Terminal resolution — the override now wins against the current
      // origin, so the merge base is no longer needed. A stale ancestor would
      // seed a wrong three-way merge on the next conflict.
      await store.remove(entry.files.ancestor);
      // The override just flipped from ignored (stale) to winning — the
      // resolved value changed even though no file content did.
      await refreshEntryNow(descriptor, entry);
    });
  });
}

// Three-way merge resolution: reconcile a stale override against its origin
// using the ancestor snapshot propagate() captured. Fields only one side changed
// are auto-resolved; fields both sides changed differently are returned in
// `conflictKeys` (left as the user's value, tentatively). When nothing truly
// conflicts the override is rewritten against the current origin (resolved) and
// the ancestor dropped; otherwise the stale hash is kept so the conflict stays
// surfaced and re-running merge after the user resolves the remaining fields
// finalizes it (idempotent — the same conflictKeys recur until resolved).
export async function mergeConflictByPath(
  storePath: string,
  opts: ConfigWriteOpts,
): Promise<{ resolved: boolean; conflictKeys: string[] }> {
  return withWriteTarget(storePath, opts, (descriptor, entry) =>
    mergeConflictNow(descriptor, entry, storePath, opts),
  );
}

async function mergeConflictNow(
  descriptor: ConfigDescriptor,
  entry: CacheEntry,
  storePath: string,
  opts: ConfigWriteOpts,
): Promise<{ resolved: boolean; conflictKeys: string[] }> {
  const store = ConfigStore.get();
  const [ow, originData, base] = await Promise.all([
    store.read(entry.files.override),
    store.read(entry.files.origin),
    store.read(entry.files.ancestor),
  ]);

  if (!base) {
    throw new Error(
      `No ancestor snapshot for "${storePath}" — three-way merge unavailable`,
    );
  }
  if (!ow) throw new Error(`Cannot read override for "${storePath}"`);
  if (!originData) throw new Error(`Cannot read origin for "${storePath}"`);

  const { merged, conflicts } = threeWayMerge(
    base.content as Record<string, JsonValue>,
    ow.content as Record<string, JsonValue>,
    originData.content as Record<string, JsonValue>,
  );
  const normalized = normalizeCollectionItems(merged, descriptor.fields);

  const resolved = conflicts.length === 0;
  const hash = resolved ? computeHash(originData.content) : ow.hash;
  await editEntry(opts, entry, "merge-conflict", async () => {
    await store.write(entry.files.override, normalized as JsonValue, hash);
    if (resolved) await store.remove(entry.files.ancestor);
    await refreshEntryNow(descriptor, entry);
  });

  return { resolved, conflictKeys: conflicts };
}

export async function deleteOverrideByPath(
  storePath: string,
  opts: ConfigWriteOpts,
): Promise<void> {
  const store = ConfigStore.get();
  await withWriteTarget(storePath, opts, (descriptor, entry) =>
    editEntry(opts, entry, "delete-override", async () => {
      // Idempotent: an "invalid" conflict can surface with no override on
      // disk (the origin itself fails the current schema). Deleting a
      // non-existent override is a no-op — defaults are already in effect.
      await store.remove(entry.files.override);
      // The override is gone, so any captured merge base is moot — drop it.
      await store.remove(entry.files.ancestor);
      await refreshEntryNow(descriptor, entry);
    }),
  );
}

/**
 * Re-sync the cache with a document whose files were rewritten behind the
 * registry — the store's agent-write ledger restoring what an agent-origin
 * request overwrote.
 *
 * The re-sync is why such a revert goes through the server at all rather than
 * rewriting files alone: the store's watch is a push-latency mechanism, not a
 * correctness one (an event can be missed), so a restore behind the server's
 * back could leave `getConfig`, the `config-v2.values` push and every
 * subscribed browser serving the agent's value indefinitely. Going through
 * `refreshEntry` / `ensureScopeEntry` makes the update deterministic.
 */
export async function reloadConfigDocument(
  storePath: string,
  scopeId: string,
): Promise<void> {
  const descriptor = getDescriptorByStorePath(storePath);
  if (!descriptor) {
    // Renamed or removed between the write and the reload. The bytes are back,
    // which is the user-visible fact; there is no cache entry left to re-sync.
    // Not an error — throwing here would strand a correctly-restored document
    // in the ledger forever.
    return;
  }

  if (!scopeId) {
    const base = getEntry(descriptor, BASE_SCOPE);
    if (base) await refreshEntry(descriptor, base);
    return;
  }

  // A scoped document's entry is BUILT FROM the files, so a restore that
  // created or destroyed them changes whether the entry should exist at all.
  // Rebuild rather than refresh — the same dispose/ensure pair forkDescriptor
  // and removeDescriptor use, so a reverted fork lands in the cache state those
  // functions would have produced.
  await withDocument(storePath, scopeId, async () => {
    disposeScopeEntry(descriptor, scopeId);
    const files = documentFiles({ storePath, scopeId });
    const store = ConfigStore.get();
    const [origin, override] = await Promise.all([
      store.read(files.origin),
      store.read(files.override),
    ]);
    if (origin !== null || override !== null)
      await ensureScopeEntryNow(descriptor, storePath, scopeId);
  });
  await notifyDescriptorScopeChange(storePath, scopeId);
}
