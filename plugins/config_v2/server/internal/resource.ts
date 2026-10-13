import { statSync } from "node:fs";
import { join } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  configValues,
  configConflict,
  configTiers,
  configScopes,
  configConflictLocations,
  configModifiedCounts,
  hasConflict,
  validationIssues,
  effective,
  threeWayMerge,
  readTypedConfigWithLayer,
} from "../../core";
import type {
  ConfigV2Values,
  ConfigV2ConflictEntry,
  ConfigV2Tiers,
  ConfigV2ScopesMap,
  ConfigV2ConflictLocations,
  ConfigV2ConflictMap,
  ConfigV2ModifiedCounts,
} from "../../core";
import type { ConfigDescriptor, ConfigValues, JsonValue } from "../../core";
import type { FieldsRecord } from "@plugins/fields/core";
import { userScopedDir, discoverScopeIds } from "./scope-paths";
import { jsoncConfigProxy } from "./jsonc-proxy";
import { hasFieldStorageProvider } from "./field-storage-providers";
import { computeFieldTiers } from "./field-tiers";

type ConfigGetter = <F extends FieldsRecord>(
  d: ConfigDescriptor<F>,
  scopeId?: string,
) => ConfigValues<F>;

const descriptorByPath = new Map<string, ConfigDescriptor>();
// hierarchyPath per descriptor (storePath minus the trailing `/<name>.jsonc`),
// captured at registration so scope helpers can rebuild scoped dirs.
const hierarchyByDescriptor = new WeakMap<ConfigDescriptor, string>();
let configGetter: ConfigGetter | null = null;

// In-memory derived state the scopes loader reads so a subscribe /
// WS-reconnect-replay / boot-snapshot read is a pure memory read (no per-load
// filesystem walk). The AUTHORITATIVE predicate is still on disk
// (scopeHasOwnConfig); this cache is recomputed from it via refreshScopeMembers
// ONLY when a config file actually changes (boot, fork, scoped write/delete).
//
// Being event-fed, it is only as fresh as the events: a config file that changes
// without producing a watcher callback leaves it stale until the next restart.
// conflict-locations and modified-counts used to be maintained this way too and no
// longer are — see the fingerprint-memoized derivation below, which is where this
// one should end up as well.

// storePath → scopeIds the descriptor has its own config for (empty paths omitted).
const scopeMembers = new Map<string, string[]>();

// Registry readiness gate. The server serves WS/HTTP resource subscriptions before
// onReady runs initRegistry, so a client can subscribe before descriptors are
// registered. The loader awaits this promise rather than answering with an empty
// config — an incomplete config object crashes consumers that destructure fields.
// initRegistry calls markRegistryReady() once every descriptor is registered.
let resolveRegistryReady!: () => void;
const registryReady = new Promise<void>((resolve) => {
  resolveRegistryReady = resolve;
});

export function markRegistryReady(): void {
  resolveRegistryReady();
}

/**
 * Resolves once `initRegistry` has registered every descriptor. A loader that
 * reads the registry (`getAllDescriptors`, a document by path) awaits it, since
 * resource subscriptions are served before `onReadyBlocking` runs: answered
 * early, it would see an empty registry.
 */
export function configRegistryReady(): Promise<void> {
  return registryReady;
}

// Wraps a loader so it resolves only after initRegistry has populated the
// registry (descriptorByPath / configGetter). Pre-readiness
// the server already serves subscriptions, so without this gate a loader answers
// from empty state — emitting an incomplete/wrong resource the client then caches.
function whenRegistryReady<A, R>(
  fn: (arg: A) => R | Promise<R>,
): (arg: A) => Promise<R> {
  return async (arg: A) => {
    await configRegistryReady();
    return fn(arg);
  };
}

// Resolve a descriptor's effective values for a scope, with storage-provider
// (secret) fields redacted to their defaults before leaving the server — the one
// place a config document is made fit for the browser.
function resolveRedactedConfig(
  descriptor: ConfigDescriptor,
  scopeId?: string,
): ConfigV2Values {
  if (!configGetter) {
    throw new Error("[config-v2] config getter not initialized");
  }
  const values = configGetter(descriptor, scopeId) as ConfigV2Values;
  const redacted = { ...values };
  for (const [key, field] of Object.entries(descriptor.fields)) {
    if (hasFieldStorageProvider(field.type.id)) {
      redacted[key] = field.defaultValue;
    }
  }
  return redacted;
}

// One descriptor's document for one scope. Preloaded: the boot snapshot loads
// every tuple a first paint can read — each registered `{ path }` plus each
// `{ path, scopeId }` with its own config — named by `preloadParams` from the
// SAME `scopeMembers` map the `config-v2.scopes` value is read from, so the
// scopes a reader decides on and the scoped documents hydrated for it cannot
// disagree. Pushed by the registry's one document fan-out (`notifyDocument`),
// together with the conflicts and tiers of the same tuple.
export const configValuesServed = serveValue(configValues, {
  source: "external",
  changes: "notified",
  loader: whenRegistryReady(({ path, scopeId }) => {
    const descriptor = descriptorByPath.get(path);
    if (!descriptor || !configGetter) {
      // After readiness, an unregistered path is a genuine bug (unknown descriptor)
      // — fail loudly rather than emit an empty config that breaks consumers.
      throw new Error(
        `[config-v2] no descriptor registered for resource path "${path}"`,
      );
    }
    return resolveRedactedConfig(descriptor, scopeId);
  }),
  preloadParams: async () => {
    await registryReady;
    const tuples: { path: string; scopeId?: string }[] = [];
    for (const path of descriptorByPath.keys()) {
      tuples.push({ path });
      for (const scopeId of scopeMembers.get(path) ?? []) {
        tuples.push({ path, scopeId });
      }
    }
    return tuples;
  },
});

// The three user-layer files a descriptor's conflict state is a function of, for
// one scope. `scopeId` undefined → base config (paths land exactly where they do
// today); a scoped call rebuilds the trio under the scope's @app/<id> segment via
// userScopedDir, so a stale scoped override surfaces the same way base conflicts
// do. Shared by the conflict computation and its fingerprint, so the memo can
// never key off a different set of files than the value it caches.
function conflictFilePaths(
  storePath: string,
  scopeId?: string,
): { origin: string; override: string; ancestor: string } {
  const parts = storePath.replace(/\.jsonc$/, "").split("/");
  const dir = parts.slice(0, -1).join("/");
  const name = parts[parts.length - 1]!;
  const scopedDir = userScopedDir(dir, scopeId);
  return {
    origin: join(scopedDir, `${name}.origin.jsonc`),
    override: join(scopedDir, `${name}.jsonc`),
    ancestor: join(scopedDir, `${name}.ancestor.jsonc`),
  };
}

// Compute a SINGLE descriptor's conflict state for the given scope, or null when
// it has no conflict. Per-descriptor (not whole-map) so the conflicts resource
// recomputes only the descriptor that actually changed. Reads and parses all
// three files — go through derivedDescriptorConflict, which skips this when the
// files are provably unchanged.
function computeDescriptorConflict(
  storePath: string,
  scopeId?: string,
): ConfigV2ConflictEntry | null {
  const descriptor = descriptorByPath.get(storePath);
  if (!descriptor) {
    throw new Error(
      `[config-v2] no descriptor registered for conflicts path "${storePath}"`,
    );
  }
  const files = conflictFilePaths(storePath, scopeId);

  const origin = jsoncConfigProxy(files.origin);
  const overwrites = jsoncConfigProxy(files.override);

  if (hasConflict(origin, overwrites)) {
    const originData = origin.read();
    const originValues = originData
      ? (originData.content as Record<string, unknown>)
      : (descriptor.defaults as Record<string, unknown>);
    const overrideData = overwrites.read();
    const overrideValues = overrideData
      ? (overrideData.content as Record<string, unknown>)
      : (descriptor.defaults as Record<string, unknown>);

    // When propagate captured a merge base (`<name>.ancestor.jsonc`), a
    // three-way merge is available: compute which fields truly conflict (both
    // sides changed differently) so the UI can offer Merge and flag only those
    // fields. A corrupt ancestor fails loud here exactly like a corrupt
    // origin/override above — consistent with how this treats its inputs.
    let trueConflictKeys: string[] | undefined;
    const ancestor = jsoncConfigProxy(files.ancestor);
    if (ancestor.exists()) {
      const base = ancestor.read()!.content as Record<string, JsonValue>;
      trueConflictKeys = threeWayMerge(
        base,
        overrideValues as Record<string, JsonValue>,
        originValues as Record<string, JsonValue>,
      ).conflicts;
    }

    return {
      kind: "hash",
      originValues,
      overrideValues,
      ...(trueConflictKeys !== undefined ? { trueConflictKeys } : {}),
    };
  }

  // No hash conflict, but the stored override may still be unusable: a foreign
  // leftover from a prior config shape, or a document that fails the current
  // schema (a field's type changed under stored data, a hand edit went wrong).
  // The app degrades to the ORIGIN (authored default), not empty code defaults;
  // surface it so the user can reset or fix it.
  const issues = validationIssues(descriptor, origin, overwrites);
  if (issues) {
    const stored = effective(origin, overwrites);
    const overrideValues =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : {};
    const originData = origin.read();
    const originValues = originData
      ? (originData.content as Record<string, unknown>)
      : (descriptor.defaults as Record<string, unknown>);
    return {
      kind: "invalid",
      originValues,
      overrideValues,
      issues,
    };
  }
  return null;
}

// Identity stamp for one file: "-" when absent, else (inode, mtime-ns, size).
//
// `ino` is what makes this airtight rather than merely likely. Every writer in
// this plugin goes through jsoncConfigProxy.write, which writes a temp file and
// renames it into place — so the inode changes on EVERY write, including an
// acknowledge-conflict restamp that only swaps the 12 hex chars in the `// @hash`
// header and is therefore byte-length-identical (and can land in the same
// millisecond) as the file it replaced. mtime-ns + size then cover in-place
// writes from an external editor.
function fileStamp(path: string): string {
  const st = statSync(path, { bigint: true, throwIfNoEntry: false });
  if (!st) return "-";
  return `${st.ino}:${st.mtimeNs}:${st.size}`;
}

// Fingerprint-keyed memo of everything a descriptor's file trio determines,
// keyed by (storePath, scopeId). Unbounded only in the number of (descriptor ×
// scope) pairs the process ever observes; a vanished scope leaves one small
// stale entry that can never be returned for another key.
//
// `tiers` is a LAZY slot, not a field computed beside `entry`:
// descriptorHasAnyConflict sweeps every descriptor × scope on every
// conflict-locations load and reads only `entry`, so it must not start paying to
// normalize and diff two documents it never looks at.
interface DerivedTrioState {
  fingerprint: string;
  entry: ConfigV2ConflictEntry | null;
  tiers?: ConfigV2Tiers;
}
const conflictMemo = new Map<string, DerivedTrioState>();

// THE conflict derivation. A descriptor's conflict state is a pure function of
// its file trio plus the descriptor itself (code — constant for the process), so
// memoize the expensive part on a fingerprint of that trio taken straight off the
// filesystem.
//
// The load-bearing property is WHERE THE KEY COMES FROM: the disk, not an event.
// The aggregate conflict-locations set used to be maintained purely from watcher
// callbacks, so any change that produced no CALLBACK left the nav badge wrong
// until the next restart while the detail pane — which re-derives from disk —
// said the opposite. config-watcher only calls back for paths some CacheEntry
// registered, and scoped entries exist only for scopes discovered at boot or
// forked in-process: a scoped override appearing under @app/<id> for any other
// scope therefore reaches nobody. (Plus the generic hazards: a dropped fsevent, a
// writer parcel doesn't observe.) With a disk-derived key the worst case of a
// missed event is a recompute, never a wrong answer.
//
// Cost: statSync is roughly two orders of magnitude cheaper than
// read + JSONC-parse + hash — a measured ~10ms to sweep every descriptor
// (~250 of them, ~800 stats) against ~1.2s just to re-read the same file trios.
// Deliberately NOT infra/corpus-index:
// that primitive walks directories, persists its index to disk and gates on the
// heavy-read pool — this one indexes a fixed, already-known path trio per
// descriptor, lives only in this process, and must be cheap enough to run inside
// a resource loader.
function derivedTrioState(
  storePath: string,
  scopeId?: string,
): DerivedTrioState {
  const files = conflictFilePaths(storePath, scopeId);
  const fingerprint = `${fileStamp(files.origin)}|${fileStamp(files.override)}|${fileStamp(files.ancestor)}`;
  const memoKey = `${storePath}|${scopeId ?? ""}`;

  const memo = conflictMemo.get(memoKey);
  if (memo && memo.fingerprint === fingerprint) return memo;

  const state: DerivedTrioState = {
    fingerprint,
    entry: computeDescriptorConflict(storePath, scopeId),
  };
  conflictMemo.set(memoKey, state);
  return state;
}

function derivedDescriptorConflict(
  storePath: string,
  scopeId?: string,
): ConfigV2ConflictEntry | null {
  return derivedTrioState(storePath, scopeId).entry;
}

// The detail-pane banner. Routed through the same memo as the aggregate below so
// the two surfaces share one code path AND one cache — they read the identical
// value for a descriptor, not two independently-derived ones.
//
// Notified in lock-step with the document: the registry's one fan-out
// (`notifyDocument`) notifies the values, conflicts and tiers of every tuple a
// change moves, so no writer can move one and forget the others.
export const configConflictServed = serveValue(configConflict, {
  source: "external",
  changes: "notified",
  loader: whenRegistryReady(({ path, scopeId }) =>
    derivedDescriptorConflict(path, scopeId),
  ),
});

// The whole scope-membership map, read from the in-memory cache (no filesystem
// walk per load). Refreshed via refreshScopeMembers whenever a scoped file moves.
// EVERY registered path is present (`[]` when it has no scope of its own): the
// map is also the client's list of server-registered paths.
export const configScopesServed = serveValue(configScopes, {
  source: "external",
  changes: "notified",
  loader: whenRegistryReady((): ConfigV2ScopesMap =>
    Object.fromEntries(
      [...descriptorByPath.keys()].map((path) => [
        path,
        scopeMembers.get(path) ?? [],
      ]),
    ),
  ),
});

// Recompute one descriptor's scope membership from the AUTHORITATIVE disk
// predicate (scopeHasOwnConfig) and update the in-memory map. Notifies the global
// scopes resource iff membership changed. Called at boot and at every point a
// scoped origin/override file appears or disappears — never on a plain read.
export function refreshScopeMembers(storePath: string): void {
  const descriptor = descriptorByPath.get(storePath);
  if (!descriptor) return;
  const hierarchyPath = hierarchyByDescriptor.get(descriptor);
  const ids = hierarchyPath
    ? discoverScopeIds(hierarchyPath).filter((sid) =>
        scopeHasOwnConfig(descriptor, sid),
      )
    : [];
  const prev = scopeMembers.get(storePath) ?? [];
  const changed =
    ids.length !== prev.length || ids.some((id, i) => id !== prev[i]);
  if (ids.length > 0) scopeMembers.set(storePath, ids);
  else scopeMembers.delete(storePath);
  if (changed) configScopesServed.notify();
}

// WHERE a descriptor conflicts — its base document and/or the app scopes it is
// customized for — or null when it conflicts nowhere. Bounded to that one
// descriptor's files, so it is cheap enough to run both per-change and inside the
// aggregate sweep.
//
// It reports the scope ids rather than a boolean because every surface that
// paints the warning has to be able to say what it is about: a badge that only
// knows "somewhere" sends the user to a detail pane opening on a clean Base.
//
// Scopes are enumerated straight from the filesystem (discoverScopeIds), NOT from
// the event-fed scopeMembers map: a derivation founded on the disk must not
// inherit another cache's staleness, or a scope that appeared without a watcher
// event would be invisible to the badge again. discoverScopeIds is one stat for
// the (usually absent) @app dir, and an absent file trio computes to null — so
// listing a scope that has no files for THIS descriptor costs three stats and
// answers "no conflict".
function descriptorConflictLocations(
  storePath: string,
): ConfigV2ConflictLocations | null {
  const base = derivedDescriptorConflict(storePath) !== null;
  const scopeIds: string[] = [];
  const descriptor = descriptorByPath.get(storePath);
  const hierarchyPath = descriptor && hierarchyByDescriptor.get(descriptor);
  if (hierarchyPath) {
    for (const sid of discoverScopeIds(hierarchyPath)) {
      if (derivedDescriptorConflict(storePath, sid) !== null)
        scopeIds.push(sid);
    }
  }
  if (!base && scopeIds.length === 0) return null;
  return { base, scopeIds };
}

// Every conflicting storePath mapped to where it conflicts (base + app scopes).
// Backs the nav-row warning badge and its tooltip, the detail pane's
// conflict-is-in-another-scope banner, the scope-tab dots, and the rail/sidebar
// attention dots.
//
// THE AUTHORITY: derived on every load from the same computeDescriptorConflict
// (through the same memo) that the per-descriptor `config-v2.conflicts` resource
// answers the detail-pane banner with, so the badge and the banner cannot
// disagree by construction. It is a filesystem sweep, but a stat-only one for
// every descriptor whose files haven't moved since the last derivation.
export const configConflictLocationsServed = serveValue(
  configConflictLocations,
  {
    source: "external",
    changes: "notified",
    loader: whenRegistryReady(() => {
      const out: ConfigV2ConflictMap = {};
      for (const storePath of descriptorByPath.keys()) {
        const locations = descriptorConflictLocations(storePath);
        if (locations) out[storePath] = locations;
      }
      return out;
    }),
  },
);

// Locations last PUBLISHED to subscribers, serialized — change detection for the
// push path ONLY, never the value any loader reads. (It used to be the value,
// which is exactly how the badge could get stuck disagreeing with the detail
// pane.) Serialized rather than held structurally so "the same conflict moved to
// another scope" counts as a change the way it reads to the user.
const publishedConflictLocations = new Map<string, string>();

// Push path: on a watcher callback or an in-process resolution, re-derive THIS
// descriptor and notify subscribers immediately if its locations moved, so
// fixing a conflict clears the badge without waiting for anything to re-read.
// Purely a latency optimization now — the loader re-derives from disk on every
// load regardless, so failing to call this can delay a push but can never leave a
// wrong value behind. Also called at boot to seed both the memo and this snapshot
// (so the first real change doesn't emit a spurious notify).
export function refreshConflictLocations(storePath: string): void {
  if (!descriptorByPath.has(storePath)) return;
  const locations = descriptorConflictLocations(storePath);
  const next = locations ? JSON.stringify(locations) : "";
  const prev = publishedConflictLocations.get(storePath) ?? "";
  if (next === prev) return;
  if (next) publishedConflictLocations.set(storePath, next);
  else publishedConflictLocations.delete(storePath);
  configConflictLocationsServed.notify();
}

// Per-descriptor count of BASE fields the USER LAYER supplied — the fields whose
// value differs from what the repo commits (the generated origin ⊕ any committed
// authored override, propagated down by ./singularity build). Paths with zero
// modified fields are omitted.
//
// Reads the same per-field tier attribution the detail pane's stripes and Reset
// buttons key off, so the badge and the pane cannot disagree about what
// "modified" means. Secret-backed fields are forced to "default" by computeTiers,
// so they never register.
//
// Returns 0 for an unregistered path rather than throwing the way computeTiers
// does: this runs inside an aggregate sweep over every descriptor, where one
// unknown path must not blank the whole nav.
function computeModifiedCount(storePath: string): number {
  if (!descriptorByPath.has(storePath)) return 0;
  let count = 0;
  for (const tier of Object.values(computeTiers(storePath))) {
    if (tier === "user") count++;
  }
  return count;
}

// The whole map, DERIVED ON EVERY LOAD from the fingerprint memo — the same
// authority-on-disk treatment conflict-locations gets, and for the same reason: the
// map used to be an event-fed in-memory cache, so a config file that changed
// without producing a watcher callback left the badge wrong until the next
// restart. With the memo key taken from the filesystem, a missed event can only
// delay a push, never produce a wrong answer.
//
// Cost is the stat-only sweep conflict-locations already pays on this surface: a
// descriptor whose files haven't moved is three statSyncs, and only the
// descriptors that actually have a user override do the diff.
export const configModifiedCountsServed = serveValue(configModifiedCounts, {
  source: "external",
  changes: "notified",
  loader: whenRegistryReady(() => {
    const out: ConfigV2ModifiedCounts = {};
    for (const storePath of descriptorByPath.keys()) {
      const count = computeModifiedCount(storePath);
      if (count > 0) out[storePath] = count;
    }
    return out;
  }),
});

// Count last PUBLISHED per path — change detection for the push path ONLY, never
// the value the loader reads. (Mirrors publishedConflictLocations; it is what stops a
// write that leaves the count unchanged from pushing the whole map to every
// subscriber.)
const publishedModifiedCounts = new Map<string, number>();

// Push path: on a watcher callback or an in-process write, re-derive THIS
// descriptor and notify iff its count moved. Purely a latency mechanism — the
// loader re-derives from disk regardless, so failing to call this can delay a
// badge but can never leave a wrong count behind. Also called at boot to seed the
// snapshot, so the first real change doesn't emit a spurious notify.
export function refreshModifiedCount(storePath: string): void {
  if (!descriptorByPath.has(storePath)) return;
  const prev = publishedModifiedCounts.get(storePath) ?? 0;
  const count = computeModifiedCount(storePath);
  if (count === prev) return;
  if (count > 0) publishedModifiedCounts.set(storePath, count);
  else publishedModifiedCounts.delete(storePath);
  configModifiedCountsServed.notify();
}

export function registerDescriptorPath(
  path: string,
  descriptor: ConfigDescriptor,
  hierarchyPath: string,
): void {
  descriptorByPath.set(path, descriptor);
  hierarchyByDescriptor.set(descriptor, hierarchyPath);
}

export function getDescriptorByStorePath(
  path: string,
): ConfigDescriptor | undefined {
  return descriptorByPath.get(path);
}

export function getHierarchyPath(
  descriptor: ConfigDescriptor,
): string | undefined {
  return hierarchyByDescriptor.get(descriptor);
}

// A scope "has its own config" when EITHER its scoped origin (a propagated git
// scope — committed config/<hier>/@app/<id>/) OR its scoped override (a runtime
// fork) exists. Such a scope resolves to its own values and is decoupled from
// base; an untracked scope resolves base live. Covers both a committed git scope
// (origin but no user override) and a runtime fork (override) — the single
// authoritative membership predicate read/write/server-resolve all key off.
export function scopeHasOwnConfig(
  descriptor: ConfigDescriptor,
  scopeId: string,
): boolean {
  if (!scopeId) return false;
  const hierarchyPath = hierarchyByDescriptor.get(descriptor);
  if (!hierarchyPath) return false;
  const scopedDir = userScopedDir(hierarchyPath, scopeId);
  return (
    jsoncConfigProxy(join(scopedDir, `${descriptor.name}.jsonc`)).exists() ||
    jsoncConfigProxy(
      join(scopedDir, `${descriptor.name}.origin.jsonc`),
    ).exists()
  );
}

// Every scope with its OWN document for `descriptor` (a committed git scope, a
// runtime fork, or a plain scoped write) — read from disk through the same
// `scopeHasOwnConfig` predicate as the scopes resource, not from its event-fed
// map, so a server consumer asking "which scopes chose X?" can't see a stale
// answer. The base scope is not listed; read it with `getConfig(descriptor)`.
export function getConfigScopeIds(descriptor: ConfigDescriptor): string[] {
  const hierarchyPath = hierarchyByDescriptor.get(descriptor);
  if (!hierarchyPath) {
    throw new Error(
      `[config-v2] getConfigScopeIds: descriptor "${descriptor.name}" is not registered.`,
    );
  }
  return discoverScopeIds(hierarchyPath).filter((sid) =>
    scopeHasOwnConfig(descriptor, sid),
  );
}

// All registered descriptors tagged with the given scope kind, plus their
// hierarchyPath and storePath. Used by fork/unfork to act on the whole scoped set.
export function getScopedDescriptors(scope: "app"): {
  descriptor: ConfigDescriptor;
  hierarchyPath: string;
  storePath: string;
}[] {
  const out: {
    descriptor: ConfigDescriptor;
    hierarchyPath: string;
    storePath: string;
  }[] = [];
  for (const [storePath, descriptor] of descriptorByPath) {
    if (descriptor.scope !== scope) continue;
    const hierarchyPath = hierarchyByDescriptor.get(descriptor);
    if (!hierarchyPath) continue;
    out.push({ descriptor, hierarchyPath, storePath });
  }
  return out;
}

export function setConfigGetter(getter: ConfigGetter): void {
  configGetter = getter;
}

// THE per-field layer attribution: which layer supplied each field's value.
// Backs the `git`/`user` badges, the "modified" stripe, the per-field Reset and
// the nav count — one answer, so those four cannot disagree.
//
// Memoized on the same file-trio fingerprint as the conflict entry, and computed
// lazily inside it, so opening a detail pane costs one read of documents the
// conflict derivation may already have paid for.
function computeTiers(path: string, scopeId?: string): ConfigV2Tiers {
  const descriptor = descriptorByPath.get(path);
  if (!descriptor) {
    // After readiness, an unregistered path is a genuine bug (unknown descriptor)
    // — fail loudly rather than emit empty tiers that render every field as "default".
    throw new Error(
      `[config-v2] no descriptor registered for tiers path "${path}"`,
    );
  }

  const state = derivedTrioState(path, scopeId);
  if (!state.tiers) {
    const files = conflictFilePaths(path, scopeId);
    const resolved = readTypedConfigWithLayer(
      descriptor,
      jsoncConfigProxy(files.origin),
      jsoncConfigProxy(files.override),
    );
    state.tiers = computeFieldTiers({
      fields: descriptor.fields,
      defaults: descriptor.defaults as Record<string, unknown>,
      layer: resolved.layer,
      originContent: resolved.originContent,
      overrideContent: resolved.overrideContent,
    });
  }

  // Provider-backed (secret) fields live outside the JSONC document entirely, so
  // no document comparison can speak for them. Forced here rather than inside the
  // memo because registerFieldStorageProvider is a module side effect — a
  // memoized answer taken before it ran would stick until the file next moved.
  const tiers: ConfigV2Tiers = { ...state.tiers };
  for (const [key, field] of Object.entries(descriptor.fields)) {
    if (hasFieldStorageProvider(field.type.id)) tiers[key] = "default";
  }
  return tiers;
}

// Notified in lock-step with the document, exactly like `configConflictServed`.
export const configTiersServed = serveValue(configTiers, {
  source: "external",
  changes: "notified",
  loader: whenRegistryReady(({ path, scopeId }) => computeTiers(path, scopeId)),
});

export function getAllDescriptors(): [string, ConfigDescriptor][] {
  return [...descriptorByPath.entries()];
}
