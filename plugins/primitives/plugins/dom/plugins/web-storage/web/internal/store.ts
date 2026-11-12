import type { z } from "zod";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import { describeSchema } from "@plugins/packages/plugins/zod-introspect/core";
import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import {
  AREA_BUDGET,
  entryBytes,
  OWNER_PATTERN,
  ownerPrefix,
  parseStorageSize,
  parseStoreKey,
  SCOPE_PATTERN,
  type StorageArea,
  type StorageSize,
} from "../../core";

/**
 * The one door to Web Storage. Every owner declares, once at module scope, the
 * prefix its keys live under, a byte cap, a TTL and what happens when it is
 * full. The caps of every owner of an area sum to less than what the browser
 * allows (`AREA_BUDGET`, enforced here at runtime and by the `budget-fits`
 * check statically), so no owner can be refused by the browser because
 * ANOTHER owner grew — the 2026-10-19 incident, where the theme cache filled
 * localStorage and every draft write failed from then on.
 *
 * A store's entries are per composition scope unless it is declared
 * `pageWide`: what `/demo`'s embedded app writes (inside its `PluginScope`)
 * lands under `s:<owner>@<scope>:`, never in the page's own `s:<owner>:` keys.
 * A scoped store has no read or write of its own — only `in(scope)` /
 * `useStore`, with a `StorageScope` only `useStorageScope()` mints — so scoped
 * code has no unscoped spelling.
 */

/** What a store does with a write that would take it over its cap. */
export type WhenFull =
  /** Drop the store's own oldest entries until it fits — for caches (scroll offsets, widths). */
  | "evict-oldest"
  /** Refuse the write, loudly — for what the user typed and must not lose silently. */
  | "refuse";

export interface StoreSpec<T> {
  /** Unique id, `[a-z0-9.-]`; its keys are `s:<owner>:<id>`. */
  owner: string;
  /** Plural noun phrase the user reads ("Prompt drafts"): the toast and the health row. */
  label: string;
  area: StorageArea;
  cap: StorageSize;
  /** Milliseconds an entry lives after its last write; `Infinity` for never. */
  ttl: number;
  whenFull: WhenFull;
  /**
   * Decodes a stored value. Every entry is stamped with the schema that wrote
   * it: one stamped with this schema that fails it is corrupt (dropped,
   * reported); one another schema wrote (a tab on another build) is left alone
   * — read as `other-schema`, never dropped.
   */
  schema: z.ZodType<T>;
  /**
   * Set only for state about the page itself, never about what an app inside
   * it shows (the tab's id, the app tab strip, a page-level diagnostics flag):
   * its entries are the page's, wherever they are written from, and the handle
   * reads and writes directly. Absent, the store is per composition scope
   * (`ScopedStore`).
   */
  pageWide?: { reason: string };
  /**
   * Keys this owner wrote before the primitive existed: deleted on the store's
   * first use (drawn as "Legacy" in the health row until then), after `adopt`
   * — when given — carries each one over as an entry of this store (in the
   * page's own scope: they predate scopes). Remove once
   * every browser has loaded a build that migrated them.
   */
  legacy?: LegacyKeys;
}

export interface LegacyKeys {
  match(key: string): boolean;
  /** The entry an old key becomes, or `null` to drop it. Its value is checked against the schema. */
  adopt?(
    key: string,
    raw: string,
  ): { id: string; value: unknown; ts: number } | null;
}

export type StoreRead<T> =
  | { kind: "value"; value: T; ts: number }
  | {
      kind: "none";
      why:
        | "absent"
        | "expired"
        /** Written under this owner's schema, and fails it: dropped and reported. */
        | "corrupt"
        /**
         * Written under ANOTHER schema of this owner (a tab on an older or newer
         * build), and this one cannot read it: left in place for the builds
         * that can — never dropped, never reported.
         */
        | "other-schema"
        | "unavailable";
    };

export type WriteFailureReason =
  /** The value would take the owner over its own cap (a `refuse` store, or one entry bigger than the cap). */
  | "over-cap"
  /** The browser refused: the area is full. */
  | "quota"
  /** The browser refused: storage is disabled or blocked. */
  | "blocked";

export type StoreWrite =
  { ok: true } | { ok: false; reason: WriteFailureReason };

/** One refused write, or one unreadable entry, as `onStorageFailure` hands it out. */
export interface StorageFailure {
  owner: string;
  label: string;
  area: StorageArea;
  reason: WriteFailureReason | "corrupt";
  /** For `quota` / `blocked`, the DOMException's name. */
  error?: string;
}

/** A store's current footprint, as the health row lists it. */
export interface StoreUsage {
  owner: string;
  label: string;
  area: StorageArea;
  /** `null` until the store is first touched in this page (nothing has scanned it yet). */
  bytes: number | null;
  entries: number | null;
  cap: number;
  ttl: number;
  whenFull: WhenFull;
  /** Entries `evict-oldest` dropped in this page load. */
  evicted: number;
  /** Writes refused by the owner's own cap in this page load. */
  refusedOverCap: number;
  /** Writes the browser refused (area full, or storage blocked) in this page load. */
  refusedByBrowser: number;
}

export interface Store<T> {
  readonly owner: string;
  readonly label: string;
  readonly area: StorageArea;
  readonly ttl: number;
  /**
   * The composition scope this handle reads and writes in (the page's own for
   * a `pageWide` store) — for a caller announcing what it wrote, so a listener
   * hears only its own scope's writes.
   */
  readonly scope: StorageScope;
  /** The full Web Storage key for `id` — for a caller keying something else by it. */
  key(id?: string): string;
  read(id?: string): StoreRead<T>;
  write(id: string, value: T): StoreWrite;
  remove(id?: string): void;
  /** Every live entry's id, oldest first. */
  ids(): string[];
  /** Fires on a write or removal of `id` from this tab or another one. */
  subscribe(id: string, listener: () => void): () => void;
}

declare const scopeBrand: unique symbol;

/**
 * Which composition scope a store's entries are read and written in: the
 * innermost `PluginScope` (`id`), or the page's own deploy (`null`). Minted
 * only by `useStorageScope()` (from where the code renders), so no caller can
 * name another scope's keys.
 */
export interface StorageScope {
  readonly [scopeBrand]: true;
  readonly id: string | null;
}

const scopes = new Map<string | null, StorageScope>();

/**
 * The scope a `PluginScope` id stands for, one object per id (a stable hook
 * dependency) — for `useStorageScope` only (not in the barrel).
 */
export function storageScope(id: string | null): StorageScope {
  let scope = scopes.get(id);
  if (scope) return scope;
  if (id !== null && !SCOPE_PATTERN.test(id))
    throw new Error(
      `web-storage: scope "${id}" must match ${SCOPE_PATTERN} (a composition id)`,
    );
  // The brand exists only in the type: this is the one place it is minted.
  scope = { id } as StorageScope;
  scopes.set(id, scope);
  return scope;
}

/**
 * A store whose entries are per composition scope: no read or write of its
 * own. `useStore(store)` binds it to where the calling component renders;
 * `in(scope)` binds it to a scope a component read (`useStorageScope()`) for
 * an imperative caller. One bound handle per scope, so its identity is stable.
 */
export interface ScopedStore<T> {
  readonly owner: string;
  readonly label: string;
  readonly area: StorageArea;
  readonly ttl: number;
  in(scope: StorageScope): Store<T>;
}

type Entry = { bytes: number; ts: number };

/**
 * The share of a scoped owner's cap the page's own scope may never use: it is
 * the `PluginScope`s' (the demo's). Without it a cache's page entries fill the
 * whole cap — a cache's steady state — and, since a scope evicts only its own
 * entries, every write inside a scope is refused from then on (2026-11-05:
 * scroll positions refused ×13 in a Demo tab).
 */
const NESTED_SHARE = 1 / 4;

interface OwnerState<T> {
  spec: StoreSpec<T>;
  /** `schemaStamp(spec.schema)`, computed on first need. */
  stamp: string | null;
  cap: number;
  /**
   * The most the page's own scope may hold: the cap less the scopes' reserve
   * (`NESTED_SHARE`), or the whole cap for a `pageWide` store (no scopes).
   */
  pageCap: number;
  /** The page's own scope's prefix — where legacy keys are adopted. */
  prefix: string;
  /**
   * Every entry of the owner, in every scope, by full key (the cap covers them
   * all). `null` until first touch; `"unavailable"` when the area cannot be opened.
   */
  entries: Map<string, Entry> | "unavailable" | null;
  used: number;
  /** Of `used`, the page's own scope's bytes (kept against `pageCap`). */
  pageUsed: number;
  evicted: number;
  refusedOverCap: number;
  refusedByBrowser: number;
  listeners: Map<string, Set<() => void>>;
}

// A registry of heterogeneous stores; each Store<T> keeps its own T.
const owners = new Map<string, OwnerState<any>>();
const changeListeners = new Set<() => void>();

/**
 * Every failure, for the reports collector: held until it registers, so a
 * write refused during boot (before any Core.Root mounted) still files.
 */
export const storageFailureReportSink = defineReportSink<StorageFailure>();
const failureListeners = new Set<(f: StorageFailure) => void>();

/** The area's Storage, or `null` when the browser blocks it (a SecurityError on access). */
export function openArea(area: StorageArea): Storage | null {
  try {
    return area === "local" ? window.localStorage : window.sessionStorage;
  } catch (err) {
    if (err instanceof DOMException) return null;
    throw err;
  }
}

function notifyChanged(): void {
  for (const l of changeListeners) l();
}

function fail(
  state: OwnerState<unknown>,
  f: Omit<StorageFailure, "owner" | "label" | "area">,
): void {
  if (f.reason === "over-cap") state.refusedOverCap++;
  else if (f.reason !== "corrupt") state.refusedByBrowser++;
  const failure: StorageFailure = {
    owner: state.spec.owner,
    label: state.spec.label,
    area: state.spec.area,
    ...f,
  };
  storageFailureReportSink.emit(failure);
  for (const l of failureListeners) l(failure);
  notifyChanged();
}

/**
 * One stored entry. `s` is the stamp of the schema that wrote it
 * ({@link schemaStamp}): what lets a reader tell an entry its own schema
 * wrote — bytes that fail it are corrupt — from one another build's schema
 * wrote, which it has no right to judge. Absent on entries written before
 * stamps existed: their writer is unknown, so they are treated as another
 * schema's.
 */
type Envelope = { v: unknown; ts: number; s?: string };

/**
 * A schema's identity across builds: a hash of zod-introspect's description of
 * it (what it accepts and produces, as data), so two builds whose schema for an
 * owner is the same stamp the same, and any change to what it accepts moves
 * the stamp. A change confined to a transform's body does not (describeSchema
 * cannot see into it) — such an entry is then judged corrupt, loudly, never
 * left silently.
 */
function schemaStamp(state: OwnerState<unknown>): string {
  state.stamp ??= hash53(
    JSON.stringify(describeSchema(state.spec.schema).description),
  ).toString(36);
  return state.stamp;
}

function envelope(
  state: OwnerState<unknown>,
  value: unknown,
  ts: number,
): string {
  return JSON.stringify({
    v: value,
    ts,
    s: schemaStamp(state),
  } satisfies Envelope);
}

function parseEnvelope(raw: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    !("ts" in parsed) ||
    typeof parsed.ts !== "number" ||
    ("s" in parsed && typeof parsed.s !== "string")
  )
    return null;
  return {
    v: parsed.v,
    ts: parsed.ts,
    ...("s" in parsed && typeof parsed.s === "string" ? { s: parsed.s } : {}),
  };
}

function expired(state: OwnerState<unknown>, ts: number): boolean {
  return Date.now() - ts > state.spec.ttl;
}

/**
 * The store's entries, scanning the area once on first touch. The scan is also
 * the TTL sweep (expired entries are deleted) and the legacy cleanup, so an
 * owner's footprint is exact from its first use on and stays so from its own
 * writes plus the `storage` event (other tabs).
 */
function load<T>(state: OwnerState<T>): Map<string, Entry> | null {
  if (state.entries === "unavailable") return null;
  if (state.entries) return state.entries;
  const store = openArea(state.spec.area);
  if (!store) {
    state.entries = "unavailable";
    return null;
  }
  installCrossTabListener();
  const entries = new Map<string, Entry>();
  const drop: string[] = [];
  const legacy: string[] = [];
  state.used = 0;
  state.pageUsed = 0;
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null) continue;
      if (state.spec.legacy?.match(key)) {
        legacy.push(key);
        continue;
      }
      if (parseStoreKey(key)?.owner !== state.spec.owner) continue;
      const raw = store.getItem(key) ?? "";
      const env = parseEnvelope(raw);
      if (!env || expired(state, env.ts)) {
        drop.push(key);
        continue;
      }
      remember(state, entries, key, {
        bytes: entryBytes(key, raw),
        ts: env.ts,
      });
    }
    for (const key of drop) store.removeItem(key);
    for (const key of legacy) {
      const adopted = state.spec.legacy?.adopt?.(key, store.getItem(key) ?? "");
      store.removeItem(key);
      if (!adopted || expired(state, adopted.ts)) continue;
      const parsed = state.spec.schema.safeParse(adopted.value);
      const newKey = `${state.prefix}${adopted.id}`;
      if (!parsed.success || entries.has(newKey)) continue;
      const raw = envelope(state, parsed.data, adopted.ts);
      const bytes = entryBytes(newKey, raw);
      if (
        state.pageUsed + bytes > state.pageCap ||
        state.used + bytes > state.cap
      )
        continue;
      try {
        store.setItem(newKey, raw);
      } catch (err) {
        // The area is full of someone else's keys: the old entry is lost, and
        // so is the next write — which reports it.
        if (err instanceof DOMException) continue;
        throw err;
      }
      remember(state, entries, newKey, { bytes, ts: adopted.ts });
    }
    // Page entries written before the scopes' reserve existed (or by a tab on
    // an older build) may sit in it: a cache gives them back now, so a scope's
    // first write is not refused. A `refuse` store keeps them — what the user
    // typed is never dropped silently; a page write that would grow it is
    // refused until it shrinks.
    if (
      state.spec.whenFull === "evict-oldest" &&
      state.pageUsed > state.pageCap
    ) {
      const page = [...entries]
        .filter(([k]) => isPageKey(k))
        .sort((a, b) => a[1].ts - b[1].ts);
      for (const [key] of page) {
        if (state.pageUsed <= state.pageCap) break;
        store.removeItem(key);
        forget(state, entries, key);
        state.evicted++;
      }
    }
  } catch (err) {
    if (!(err instanceof DOMException)) throw err;
    state.entries = "unavailable";
    return null;
  }
  state.entries = entries;
  notifyChanged();
  return entries;
}

function listenersOf(state: OwnerState<unknown>, key: string): void {
  const set = state.listeners.get(key);
  if (set) for (const l of set) l();
}

/** Whether `key` is in the page's own scope (outside every `PluginScope`). */
function isPageKey(key: string): boolean {
  return parseStoreKey(key)?.scope === null;
}

/** Record an entry (replacing the key's previous one) in the owner's accounting. */
function remember(
  state: OwnerState<unknown>,
  entries: Map<string, Entry>,
  key: string,
  entry: Entry,
): void {
  forget(state, entries, key);
  entries.set(key, entry);
  state.used += entry.bytes;
  if (isPageKey(key)) state.pageUsed += entry.bytes;
}

function forget(
  state: OwnerState<unknown>,
  entries: Map<string, Entry>,
  key: string,
): void {
  const prev = entries.get(key);
  if (!prev) return;
  state.used -= prev.bytes;
  if (isPageKey(key)) state.pageUsed -= prev.bytes;
  entries.delete(key);
}

function removeKey(state: OwnerState<unknown>, key: string): void {
  const entries = load(state);
  const store = openArea(state.spec.area);
  if (!entries || !store) return;
  try {
    store.removeItem(key);
  } catch (err) {
    if (!(err instanceof DOMException)) throw err;
    return;
  }
  forget(state, entries, key);
}

let crossTabInstalled = false;

/** One `storage` listener for every owner: another tab wrote or removed one of our keys. */
function installCrossTabListener(): void {
  if (crossTabInstalled) return;
  crossTabInstalled = true;
  window.addEventListener("storage", (e) => {
    if (e.storageArea === null) return;
    const area: StorageArea | null =
      e.storageArea === openArea("local")
        ? "local"
        : e.storageArea === openArea("session")
          ? "session"
          : null;
    if (area === null) return;
    if (e.key === null) {
      // `clear()` in another tab: every owner of the area rescans on next touch.
      for (const s of owners.values())
        if (s.spec.area === area) s.entries = null;
      notifyChanged();
      return;
    }
    const parsed = parseStoreKey(e.key);
    if (parsed === null) return;
    const state = owners.get(parsed.owner);
    if (!state || state.spec.area !== area || !(state.entries instanceof Map))
      return;
    forget(state, state.entries, e.key);
    if (e.newValue !== null) {
      const env = parseEnvelope(e.newValue);
      remember(state, state.entries, e.key, {
        bytes: entryBytes(e.key, e.newValue),
        ts: env?.ts ?? Date.now(),
      });
    }
    listenersOf(state, e.key);
    notifyChanged();
  });
}

function areaTotal(area: StorageArea): number {
  let total = 0;
  for (const s of owners.values()) if (s.spec.area === area) total += s.cap;
  return total;
}

/**
 * Declare a storage owner. Call once, at module scope, with literal values —
 * the `budget-fits` check reads every declaration statically. Per composition
 * scope (a `ScopedStore`) unless declared `pageWide`.
 */
export function defineStore<T>(
  spec: StoreSpec<T> & { pageWide: { reason: string } },
): Store<T>;
export function defineStore<T>(
  spec: StoreSpec<T> & { pageWide?: undefined },
): ScopedStore<T>;
export function defineStore<T>(spec: StoreSpec<T>): Store<T> | ScopedStore<T> {
  if (!OWNER_PATTERN.test(spec.owner))
    throw new Error(
      `web-storage: owner "${spec.owner}" must match ${OWNER_PATTERN}`,
    );
  if (owners.has(spec.owner))
    throw new Error(`web-storage: owner "${spec.owner}" is declared twice`);
  const cap = parseStorageSize(spec.cap);
  const state: OwnerState<T> = {
    spec,
    stamp: null,
    cap,
    pageCap: spec.pageWide ? cap : cap - Math.floor(cap * NESTED_SHARE),
    prefix: ownerPrefix(spec.owner),
    entries: null,
    used: 0,
    pageUsed: 0,
    evicted: 0,
    refusedOverCap: 0,
    refusedByBrowser: 0,
    listeners: new Map(),
  };
  owners.set(spec.owner, state);
  const budget = parseStorageSize(AREA_BUDGET[spec.area]);
  if (areaTotal(spec.area) > budget) {
    owners.delete(spec.owner);
    throw new Error(
      `web-storage: declaring "${spec.owner}" (${spec.cap}) takes the ${spec.area} owners' caps over the area budget of ${AREA_BUDGET[spec.area]} — lower a cap`,
    );
  }
  if (spec.pageWide) return bind(state, null);
  const bound = new Map<string | null, Store<T>>();
  return {
    owner: spec.owner,
    label: spec.label,
    area: spec.area,
    ttl: spec.ttl,
    in(scope) {
      let store = bound.get(scope.id);
      if (!store) bound.set(scope.id, (store = bind(state, scope.id)));
      return store;
    },
  };
}

/**
 * Which of an owner's entries a write of `bytes` to `k` in `scope` evicts so it
 * fits, oldest first — or `null` when it cannot fit (refused, nothing evicted).
 * Two bounds: the owner's cap, across every scope; and, for the page's own
 * scope, `pageCap`, so the scopes' reserve is always theirs to fill.
 *
 * No scope pays for another's growth: the page's own scope evicts the scopes'
 * entries first (even in a `refuse` store — state a Reset throws away anyway),
 * then its own oldest for an `evict-oldest` cache; a `PluginScope` evicts its
 * own oldest, then the other scopes' (a cache only), never the page's. Since
 * the page's entries stay within `pageCap`, a cache's write inside a scope
 * always fits once it evicts enough — unless one value outgrows the reserve.
 * A write that does not grow its entry always fits.
 */
function planEviction(
  state: OwnerState<unknown>,
  entries: Map<string, Entry>,
  k: string,
  scope: string | null,
  bytes: number,
): string[] | null {
  const cache = state.spec.whenFull === "evict-oldest";
  const prev = entries.get(k)?.bytes ?? 0;
  // Rewriting an entry no bigger than it was grows nothing — even an owner
  // over a bound (a tab on an older build wrote past it) takes it.
  if (bytes <= prev) return [];
  const own: [string, Entry][] = [];
  const nested: [string, Entry][] = [];
  for (const e of entries) {
    if (e[0] === k) continue;
    const entryScope = parseStoreKey(e[0])?.scope ?? null;
    if (entryScope === scope) own.push(e);
    else if (entryScope !== null) nested.push(e);
  }
  // Oldest first: Map order is insertion order, not ts order, so sort.
  const oldest = (a: [string, Entry], b: [string, Entry]) => a[1].ts - b[1].ts;
  own.sort(oldest);
  nested.sort(oldest);

  const plan = new Set<string>();
  let freed = 0;
  /** Take from `list` until `freed` covers `room`; whether it does. */
  const take = (list: [string, Entry][], room: number): boolean => {
    for (const [key, entry] of list) {
      if (freed >= room) break;
      if (plan.has(key)) continue;
      plan.add(key);
      freed += entry.bytes;
    }
    return freed >= room;
  };

  if (scope === null) {
    const pageRoom = state.pageUsed - prev + bytes - state.pageCap;
    if (pageRoom > 0 && !(cache && take(own, pageRoom))) return null;
  }
  const capRoom = state.used - prev + bytes - state.cap;
  if (capRoom > 0) {
    const order =
      scope === null
        ? [nested, ...(cache ? [own] : [])]
        : cache
          ? [own, nested]
          : [];
    if (!order.some((list) => take(list, capRoom))) return null;
  }
  return [...plan];
}

/** The handle over one owner's entries in one scope (`null`: the page's own). */
function bind<T>(state: OwnerState<T>, scope: string | null): Store<T> {
  const { spec } = state;
  const cap = state.cap;
  const prefix = ownerPrefix(spec.owner, scope);
  const key = (id = "") => `${prefix}${id}`;

  return {
    owner: spec.owner,
    label: spec.label,
    area: spec.area,
    ttl: spec.ttl,
    scope: storageScope(scope),
    key,

    read(id = "") {
      const k = key(id);
      const entries = load(state);
      const store = openArea(spec.area);
      if (!entries || !store) return { kind: "none", why: "unavailable" };
      let raw: string | null;
      try {
        raw = store.getItem(k);
      } catch (err) {
        if (err instanceof DOMException)
          return { kind: "none", why: "unavailable" };
        throw err;
      }
      if (raw === null) return { kind: "none", why: "absent" };
      const env = parseEnvelope(raw);
      if (env && expired(state, env.ts)) {
        removeKey(state, k);
        notifyChanged();
        return { kind: "none", why: "expired" };
      }
      const parsed = env ? spec.schema.safeParse(env.v) : null;
      if (env && parsed?.success)
        return { kind: "value", value: parsed.data, ts: env.ts };
      // A valid envelope from another schema: a tab on another build wrote
      // what that build reads. Not ours to judge, so never ours to drop — the
      // user's value stays for every tab that can read it.
      if (env && env.s !== schemaStamp(state))
        return { kind: "none", why: "other-schema" };
      // Our own schema wrote it (or no build could have: not an envelope):
      // our bytes failing our schema, a bug — dropped and reported.
      removeKey(state, k);
      fail(state, { reason: "corrupt" });
      return { kind: "none", why: "corrupt" };
    },

    write(id, value) {
      const k = key(id);
      const entries = load(state);
      const store = openArea(spec.area);
      if (!entries || !store) {
        fail(state, { reason: "blocked" });
        return { ok: false, reason: "blocked" };
      }
      const now = Date.now();
      const raw = envelope(state, value, now);
      const bytes = entryBytes(k, raw);
      const prev = entries.get(k)?.bytes ?? 0;
      if (
        state.used - prev + bytes > cap ||
        (scope === null && state.pageUsed - prev + bytes > state.pageCap)
      ) {
        // Entries that expired since the first-touch sweep make room first.
        for (const [key, entry] of [...entries])
          if (key !== k && expired(state, entry.ts)) removeKey(state, key);
      }
      const victims = planEviction(state, entries, k, scope, bytes);
      if (victims === null) {
        fail(state, { reason: "over-cap" });
        return { ok: false, reason: "over-cap" };
      }
      for (const victim of victims) {
        removeKey(state, victim);
        state.evicted++;
        listenersOf(state, victim);
      }
      try {
        store.setItem(k, raw);
      } catch (err) {
        if (!(err instanceof DOMException)) throw err;
        const reason = err.name === "QuotaExceededError" ? "quota" : "blocked";
        fail(state, { reason, error: err.name });
        return { ok: false, reason };
      }
      remember(state, entries, k, { bytes, ts: now });
      listenersOf(state, k);
      notifyChanged();
      return { ok: true };
    },

    remove(id = "") {
      const k = key(id);
      removeKey(state, k);
      listenersOf(state, k);
      notifyChanged();
    },

    ids() {
      const entries = load(state);
      if (!entries) return [];
      return [...entries]
        .filter(([k]) => k.startsWith(prefix))
        .sort((a, b) => a[1].ts - b[1].ts)
        .map(([k]) => k.slice(prefix.length));
    },

    subscribe(id, listener) {
      const k = key(id);
      let set = state.listeners.get(k);
      if (!set) state.listeners.set(k, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) state.listeners.delete(k);
      };
    },
  };
}

/** Observe every refused write and unreadable entry, of every owner. Returns the unsubscribe. */
export function onStorageFailure(
  listener: (f: StorageFailure) => void,
): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

/** Observe any change to any owner's footprint or counters (for the health row). */
export function onStorageChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Every declared owner's footprint and counters, as known in this page. */
export function storageUsage(): StoreUsage[] {
  return [...owners.values()].map((s) => ({
    owner: s.spec.owner,
    label: s.spec.label,
    area: s.spec.area,
    bytes: s.entries instanceof Map ? s.used : null,
    entries: s.entries instanceof Map ? s.entries.size : null,
    cap: s.cap,
    ttl: s.spec.ttl,
    whenFull: s.spec.whenFull,
    evicted: s.evicted,
    refusedOverCap: s.refusedOverCap,
    refusedByBrowser: s.refusedByBrowser,
  }));
}

/** Is `key` one some declared owner's `legacy` predicate claims? */
export function legacyOwnerOf(key: string): string | null {
  for (const s of owners.values())
    if (s.spec.legacy?.match(key)) return s.spec.owner;
  return null;
}

/**
 * Remove every entry of `area` — of any owner, loaded in this page or not —
 * whose id `match`es. For an id grammar several owners share, whose lifetime
 * one primitive decides: app-instance retiring an evicted generation's state
 * (`<tabId>:<instance>` ids) across every store keyed by it.
 */
export function removeEntriesWhere(
  area: StorageArea,
  match: (id: string) => boolean,
): void {
  const store = openArea(area);
  if (!store) return;
  const doomed: { key: string; owner: string }[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      const parsed = key === null ? null : parseStoreKey(key);
      if (key === null || parsed === null) continue;
      if (match(parsed.id)) doomed.push({ key, owner: parsed.owner });
    }
    for (const { key } of doomed) store.removeItem(key);
  } catch (err) {
    if (err instanceof DOMException) return;
    throw err;
  }
  for (const { key, owner } of doomed) {
    const state = owners.get(owner);
    if (state?.spec.area !== area || !(state.entries instanceof Map)) continue;
    forget(state, state.entries, key);
    listenersOf(state, key);
  }
  if (doomed.length > 0) notifyChanged();
}

/**
 * Remove every entry written inside the `PluginScope` of composition `id`, of
 * every owner and in both areas — for a scope whose whole state is thrown away
 * at once (the demo's Reset). By the scope's id rather than a `StorageScope`:
 * the one who ends a scope renders outside it. The page's own entries have no
 * scope id, so they can never be wiped this way.
 */
const scopeClearedListeners = new Set<(id: string) => void>();

/**
 * Observe `clearStorageScope` — for a module that keeps what it read from a
 * scoped store in memory (keyed by the store's full key), so a wiped scope is
 * not served from a copy that outlived it. Returns the unsubscribe.
 */
export function onStorageScopeCleared(
  listener: (id: string) => void,
): () => void {
  scopeClearedListeners.add(listener);
  return () => scopeClearedListeners.delete(listener);
}

/** Whether `key` (a store's full key) was written in the scope `id`. */
export function isKeyInScope(key: string, id: string): boolean {
  return parseStoreKey(key)?.scope === id;
}

export function clearStorageScope(id: string): void {
  if (!SCOPE_PATTERN.test(id))
    throw new Error(
      `web-storage: scope "${id}" must match ${SCOPE_PATTERN} (a composition id)`,
    );
  let changed = false;
  for (const area of ["local", "session"] as const) {
    const store = openArea(area);
    if (!store) continue;
    const doomed: { key: string; owner: string }[] = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        const parsed = key === null ? null : parseStoreKey(key);
        if (key !== null && parsed?.scope === id)
          doomed.push({ key, owner: parsed.owner });
      }
      for (const { key } of doomed) store.removeItem(key);
    } catch (err) {
      if (err instanceof DOMException) continue;
      throw err;
    }
    for (const { key, owner } of doomed) {
      changed = true;
      const state = owners.get(owner);
      if (state?.spec.area !== area || !(state.entries instanceof Map))
        continue;
      forget(state, state.entries, key);
      listenersOf(state, key);
    }
  }
  for (const l of scopeClearedListeners) l(id);
  if (changed) notifyChanged();
}
