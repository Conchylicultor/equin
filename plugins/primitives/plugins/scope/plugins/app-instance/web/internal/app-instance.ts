import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import { isEmbeddedDocument } from "@plugins/primitives/plugins/embed/web";
import {
  defineStore,
  removeEntriesWhere,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";

/**
 * The `PerformanceNavigationTiming.type` values, named locally so the union is
 * the primitive's own contract rather than whatever the ambient DOM lib calls
 * it (newer libs ship an unrelated global `NavigationType` for the Navigation
 * API, whose members are `push | replace | reload | traverse`).
 */
export type NavigationType =
  "navigate" | "reload" | "back_forward" | "prerender";

/** The pre-primitive registry key: `singularity.appInstances:<tabId>`. */
const LEGACY_REGISTRY_PREFIX = "singularity.appInstances:";

/**
 * LRU registry of this browser tab's live instance generations, active last —
 * one entry per browser tab (id = the tab id), a JSON `string[]`.
 */
const registryStore = defineStore({
  owner: "scope.app-instance",
  label: "App instances",
  area: "session",
  cap: "16 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.array(z.string()),
  legacy: {
    match: (key) => key.startsWith(LEGACY_REGISTRY_PREFIX),
    adopt: (key, raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        if (err instanceof SyntaxError) return null;
        throw err;
      }
      return {
        id: key.slice(LEGACY_REGISTRY_PREFIX.length),
        value: parsed,
        ts: Date.now(),
      };
    },
  },
});

/**
 * How many generations stay restorable in one browser tab. This is a real UX
 * knob, not hygiene: Back into an older instance is a *cross-document* load
 * that re-boots from storage, so `N` is how many bookmark hops back can be
 * fully restored. Overflow evicts from the head and sweeps the payload keys.
 */
export const RETAINED_INSTANCES = 8;

let resolvedInstanceId: string | undefined;
let mintedInstance = false;
let pageshowListener: ((event: PageTransitionEvent) => void) | undefined;

/**
 * The ONE `getEntriesByType("navigation")` type read in the app.
 *
 * Returns `null` when the entry is genuinely unavailable (jsdom, older
 * engines) — an honest absence, not an absorbed failure: callers must decide
 * what "unknown" means, and {@link getAppInstanceId} deliberately reads it as
 * `reload` because unknown must never destroy state.
 */
export function getNavigationType(): NavigationType | null {
  if (
    typeof performance === "undefined" ||
    typeof performance.getEntriesByType !== "function"
  ) {
    return null;
  }
  const entry = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  return entry ? (entry.type as NavigationType) : null;
}

/**
 * This document's instance generation — which running SPA app-state (tab set,
 * routes, focus, surface mode, window geometry) it belongs to.
 *
 * Memoized at module level, resolved on first call:
 *
 * | `getNavigationType()`     | `history.state.appInstance` | Action                          |
 * |---------------------------|-----------------------------|---------------------------------|
 * | `navigate` / `prerender`  | anything                    | mint a fresh generation         |
 * | `reload` / `back_forward` | present                     | adopt it                        |
 * | `reload` / `back_forward` | absent                      | adopt last-active; mint if none |
 * | `null` (unavailable)      | —                           | exactly as `reload`             |
 *
 * Both the registry write and the eviction sweep live inside the memoized
 * resolver, so the StrictMode double-invoke of the first caller is idempotent.
 */
export function getAppInstanceId(): string {
  resolvedInstanceId ??= resolveInstanceId();
  return resolvedInstanceId;
}

/**
 * `true` iff this document **minted** its generation rather than adopting one —
 * i.e. it is a brand-new instance that must restore nothing.
 *
 * This is the resolved outcome, not a re-derivation from the navigation type:
 * the "preserving load, but the registry was empty" row also mints, and that is
 * just as fresh as a bookmark hop. Resolves the generation first, so it is
 * valid whatever order a consumer calls it in.
 */
export function isFreshAppInstance(): boolean {
  getAppInstanceId();
  return mintedInstance;
}

/**
 * `${tabId}:${generation}` — the instance-scoped id. A plugin persisting
 * instance state declares its own `web-storage` session store and uses this as
 * the entry id; when a generation is evicted from the registry, every entry of
 * every store whose id carries it is removed.
 */
export function appInstanceId(): string {
  return `${getTabId()}:${getAppInstanceId()}`;
}

/** Stamp this document's instance onto a history-entry snapshot. */
export function stampAppInstance<T extends object>(
  state: T,
): T & { appInstance: string } {
  return { ...state, appInstance: getAppInstanceId() };
}

/**
 * The instance a history entry names, or `undefined` when it names none.
 *
 * `undefined` is an honest absence, not a swallowed error: legacy entries and
 * entries clobbered by a `replaceState({})` legitimately carry no instance, and
 * that case is a *row of the decision table* rather than a failure.
 */
export function readAppInstance(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const value = (state as { appInstance?: unknown }).appInstance;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Drop the memoized generation (and its `pageshow` listener) between tests. */
export function resetAppInstanceForTests(): void {
  resolvedInstanceId = undefined;
  mintedInstance = false;
  if (pageshowListener && typeof window !== "undefined") {
    window.removeEventListener("pageshow", pageshowListener);
  }
  pageshowListener = undefined;
}

function resolveInstanceId(): string {
  // An embedded document (a same-origin frame opened with `?embed=…`, in
  // either mode) shares
  // this browser tab's sessionStorage — and so this registry — with the host
  // page. It is not a restorable instance, so it mints a fresh generation and
  // never reads, writes or re-promotes the registry: a commit from here would
  // count against RETAINED_INSTANCES and could evict, then sweep, the host's
  // own generations just by the frame being remounted a few times.
  if (isEmbeddedDocument()) {
    mintedInstance = true;
    return crypto.randomUUID();
  }
  const navigationType = getNavigationType();
  // `null` (unavailable) falls through to the preserving branch on purpose.
  const isFreshLoad =
    navigationType === "navigate" || navigationType === "prerender";
  const registry = readRegistry();

  // On a preserving load the entry's own stamp wins; a missing stamp degrades
  // to the last-active generation rather than a mint. That direction matters:
  // minting when a generation merely *could not be read* destroys every tab the
  // user had, while adopting a stale pointer at worst restores one instance too
  // many. `apps-layout`'s redirect clobbers `history.state`, so the absent case
  // is routine, not exotic.
  const adopted = isFreshLoad
    ? undefined
    : (readAppInstance(readHistoryState()) ?? registry.at(-1));
  const instanceId = adopted ?? crypto.randomUUID();
  // The *resolved outcome*, not the nav type: row 3 with an empty registry is a
  // preserving load that still ends up minting, and for every consumer that is
  // a fresh instance in the only sense that matters.
  mintedInstance = adopted === undefined;

  commitRegistry(registry, instanceId);
  installBfcacheHardening(instanceId);
  return instanceId;
}

function readHistoryState(): unknown {
  return typeof window === "undefined" ? undefined : window.history.state;
}

/**
 * A bfcache restore re-shows a document without any boot, so nothing would
 * re-point the registry at this (still very much alive) instance. Re-promote it
 * so the last-active pointer can't go stale behind a restored document.
 */
function installBfcacheHardening(instanceId: string): void {
  if (typeof window === "undefined") return;
  pageshowListener = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    commitRegistry(readRegistry(), instanceId);
  };
  window.addEventListener("pageshow", pageshowListener);
}

function readRegistry(): string[] {
  const read = registryStore.read(getTabId());
  // Nothing readable (absent, corrupt — reported by the store — or storage
  // unavailable) means no restorable instances: the value a first load has.
  return read.kind === "value" ? read.value : [];
}

/** Append-or-promote `instanceId` to the tail, cap at N, sweep what falls off. */
function commitRegistry(registry: string[], instanceId: string): void {
  const promoted = [
    ...registry.filter((entry) => entry !== instanceId),
    instanceId,
  ];
  const retained = promoted.slice(-RETAINED_INSTANCES);
  // A refused write is reported by the store; the generation is already
  // resolved in memory, so this document keeps working, just not restorable.
  registryStore.write(getTabId(), retained);
  if (retained.length < promoted.length) sweepEvicted(retained);
}

/**
 * Remove every entry, of every owner, whose id is `<tabId>:<generation>` for a
 * no-longer-retained generation. Pinning the `<tabId>:` prefix makes it
 * impossible to touch the tab id and registry entries (their ids carry no
 * colon after the tab id).
 */
function sweepEvicted(retained: string[]): void {
  const prefix = `${getTabId()}:`;
  removeEntriesWhere(
    "session",
    (id) =>
      id.startsWith(prefix) && !retained.includes(id.slice(prefix.length)),
  );
}
