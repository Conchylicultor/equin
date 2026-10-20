import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import {
  AREA_BUDGET,
  entryBytes,
  KEY_ROOT,
  OWNER_PATTERN,
  ownerPrefix,
  parseStorageSize,
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
  /** Decodes a stored value; an entry that fails it is corrupt (dropped, reported). */
  schema: ZodParser<T>;
  /**
   * Keys this owner wrote before the primitive existed: deleted on the store's
   * first use (drawn as "Legacy" in the health row until then), after `adopt`
   * — when given — carries each one over as an entry of this store. Remove once
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
  | { kind: "none"; why: "absent" | "expired" | "corrupt" | "unavailable" };

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

type Entry = { bytes: number; ts: number };

interface OwnerState<T> {
  spec: StoreSpec<T>;
  cap: number;
  prefix: string;
  /** `null` until first touch; `"unavailable"` when the area cannot be opened. */
  entries: Map<string, Entry> | "unavailable" | null;
  used: number;
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

type Envelope = { v: unknown; ts: number };

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
    typeof parsed.ts !== "number"
  )
    return null;
  return { v: parsed.v, ts: parsed.ts };
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
  let used = 0;
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null) continue;
      if (state.spec.legacy?.match(key)) {
        legacy.push(key);
        continue;
      }
      if (!key.startsWith(state.prefix)) continue;
      const raw = store.getItem(key) ?? "";
      const env = parseEnvelope(raw);
      if (!env || expired(state, env.ts)) {
        drop.push(key);
        continue;
      }
      const bytes = entryBytes(key, raw);
      entries.set(key, { bytes, ts: env.ts });
      used += bytes;
    }
    for (const key of drop) store.removeItem(key);
    for (const key of legacy) {
      const adopted = state.spec.legacy?.adopt?.(key, store.getItem(key) ?? "");
      store.removeItem(key);
      if (!adopted || expired(state, adopted.ts)) continue;
      const parsed = state.spec.schema.safeParse(adopted.value);
      const newKey = `${state.prefix}${adopted.id}`;
      if (!parsed.success || entries.has(newKey)) continue;
      const raw = JSON.stringify({
        v: parsed.data,
        ts: adopted.ts,
      } satisfies Envelope);
      const bytes = entryBytes(newKey, raw);
      if (used + bytes > state.cap) continue;
      try {
        store.setItem(newKey, raw);
      } catch (err) {
        // The area is full of someone else's keys: the old entry is lost, and
        // so is the next write — which reports it.
        if (err instanceof DOMException) continue;
        throw err;
      }
      entries.set(newKey, { bytes, ts: adopted.ts });
      used += bytes;
    }
  } catch (err) {
    if (!(err instanceof DOMException)) throw err;
    state.entries = "unavailable";
    return null;
  }
  state.entries = entries;
  state.used = used;
  notifyChanged();
  return entries;
}

function listenersOf(state: OwnerState<unknown>, key: string): void {
  const set = state.listeners.get(key);
  if (set) for (const l of set) l();
}

function forget(
  state: OwnerState<unknown>,
  entries: Map<string, Entry>,
  key: string,
): void {
  const prev = entries.get(key);
  if (!prev) return;
  state.used -= prev.bytes;
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
    if (!e.key.startsWith(KEY_ROOT)) return;
    const owner = e.key.slice(
      KEY_ROOT.length,
      e.key.indexOf(":", KEY_ROOT.length),
    );
    const state = owners.get(owner);
    if (!state || state.spec.area !== area || !(state.entries instanceof Map))
      return;
    forget(state, state.entries, e.key);
    if (e.newValue !== null) {
      const env = parseEnvelope(e.newValue);
      const bytes = entryBytes(e.key, e.newValue);
      state.entries.set(e.key, { bytes, ts: env?.ts ?? Date.now() });
      state.used += bytes;
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
 * the `budget-fits` check reads every declaration statically.
 */
export function defineStore<T>(spec: StoreSpec<T>): Store<T> {
  if (!OWNER_PATTERN.test(spec.owner))
    throw new Error(
      `web-storage: owner "${spec.owner}" must match ${OWNER_PATTERN}`,
    );
  if (owners.has(spec.owner))
    throw new Error(`web-storage: owner "${spec.owner}" is declared twice`);
  const cap = parseStorageSize(spec.cap);
  const state: OwnerState<T> = {
    spec,
    cap,
    prefix: ownerPrefix(spec.owner),
    entries: null,
    used: 0,
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

  const key = (id = "") => `${state.prefix}${id}`;

  return {
    owner: spec.owner,
    label: spec.label,
    area: spec.area,
    ttl: spec.ttl,
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
      const parsed = env ? spec.schema.safeParse(env.v) : null;
      if (!env || !parsed?.success) {
        removeKey(state, k);
        fail(state, { reason: "corrupt" });
        return { kind: "none", why: "corrupt" };
      }
      if (expired(state, env.ts)) {
        removeKey(state, k);
        notifyChanged();
        return { kind: "none", why: "expired" };
      }
      return { kind: "value", value: parsed.data, ts: env.ts };
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
      const raw = JSON.stringify({ v: value, ts: now } satisfies Envelope);
      const bytes = entryBytes(k, raw);
      if (state.used - (entries.get(k)?.bytes ?? 0) + bytes > cap) {
        // Entries that expired since the first-touch sweep make room first.
        for (const [key, entry] of [...entries])
          if (key !== k && expired(state, entry.ts)) removeKey(state, key);
      }
      const others = state.used - (entries.get(k)?.bytes ?? 0);
      if (bytes > cap || (others + bytes > cap && spec.whenFull === "refuse")) {
        fail(state, { reason: "over-cap" });
        return { ok: false, reason: "over-cap" };
      }
      if (others + bytes > cap) {
        // Oldest first: Map order is insertion order, not ts order, so sort.
        const victims = [...entries]
          .filter(([key]) => key !== k)
          .sort((a, b) => a[1].ts - b[1].ts);
        let room = others + bytes - cap;
        for (const [victim, entry] of victims) {
          if (room <= 0) break;
          removeKey(state, victim);
          state.evicted++;
          room -= entry.bytes;
          listenersOf(state, victim);
        }
      }
      try {
        store.setItem(k, raw);
      } catch (err) {
        if (!(err instanceof DOMException)) throw err;
        const reason = err.name === "QuotaExceededError" ? "quota" : "blocked";
        fail(state, { reason, error: err.name });
        return { ok: false, reason };
      }
      forget(state, entries, k);
      entries.set(k, { bytes, ts: now });
      state.used += bytes;
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
        .sort((a, b) => a[1].ts - b[1].ts)
        .map(([k]) => k.slice(state.prefix.length));
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
      if (key === null || !key.startsWith(KEY_ROOT)) continue;
      const sep = key.indexOf(":", KEY_ROOT.length);
      if (sep < 0) continue;
      if (match(key.slice(sep + 1)))
        doomed.push({ key, owner: key.slice(KEY_ROOT.length, sep) });
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
