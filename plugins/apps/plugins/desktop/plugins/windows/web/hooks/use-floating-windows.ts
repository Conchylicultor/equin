import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { appInstanceId } from "@plugins/primitives/plugins/scope/plugins/app-instance/web";
import { nextSnapAction, type SnapDirection, type SnapZone } from "./use-snap";

/** A window's free-floating box on the desktop, plus its chrome state. */
export interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Stacking order, kept dense (`1..N`) and tier-ordered by {@link reorder}:
   * pinned windows always rank above unpinned ones, and within a tier the most
   * recently focused window wins. Applied verbatim as the container `zIndex`.
   */
  z: number;
  /**
   * "Always on top": when set, the window ranks above every unpinned window
   * regardless of focus order (enforced in {@link reorder}, not at render, so the
   * committed z stays `<= N` and the dock overlay always sits above the windows).
   */
  pinned: boolean;
  minimized: boolean;
  /**
   * The window's snap state: a half/quarter tile, `"maximize"` (full), or null
   * when free-floating at {@link Geometry.x}/y/w/h. When set, the box is derived
   * from `snapBox(snap)` (resolution-independent) and resize handles are hidden.
   */
  snap: SnapZone | null;
  /** Pre-snap free box, restored when a snapped/maximized window is dragged out or toggled back. */
  restore?: { x: number; y: number; w: number; h: number };
}

/** Stable identity for a floating window (its own monotonic id, not a tabId). */
export type WindowId = string;

/**
 * A virtual desktop (workspace): a logical grouping of windows over the single
 * floating surface — the macOS Spaces / GNOME workspaces model. There is NO
 * multi-monitor concept; a desktop is purely a window grouping. Switching
 * desktops re-uses the keep-alive "hidden" mechanism (off-desktop windows stay
 * mounted but `display:none`), so a switch is instant with zero remounts. Pills
 * are numbered (1..N); `name` is reserved for a later rename affordance.
 */
export interface Desktop {
  id: string;
  name?: string;
}

/**
 * A floating **window** — the geometry-owning unit. A window holds an ordered
 * list of member tabIds (the tab-strip order) and the one `activeTabId` it
 * currently shows; every other member stays mounted but hidden. By default each
 * floating tab is its own singleton window, so the un-grouped behaviour is
 * byte-identical to the per-tab geometry store this file replaces.
 */
export interface FloatingWindow {
  id: WindowId;
  /** Ordered member tabIds = tab-strip order. */
  members: string[];
  /** The shown member; every other member is mounted-but-hidden. */
  activeTabId: string;
  /**
   * The virtual desktop this window lives on — a window-organization property,
   * NOT part of {@link Geometry}'s box/chrome. Off-active-desktop windows stay
   * mounted but hidden (`display:none`). New windows mint on the active desktop.
   */
  desktopId: string;
  geo: Geometry;
}

/** Minimum box so a window can never be resized into nothing (mockup `min`). */
export const MIN_W = 360;
export const MIN_H = 260;

/** The work area a window is clamped within: the backdrop minus the shelf's reserve. */
export interface Bounds {
  width: number;
  height: number;
}

/** Horizontal slice (px) of a window always kept inside the work area. */
const KEEP_VISIBLE_X = 120;
/** Vertical slice (px) kept above the work area's bottom — about a titlebar. */
const KEEP_VISIBLE_Y = 40;

/**
 * Pull a free window back into the work area — the mockup's `clamp`: the box
 * is no larger than the work area, keeps {@link KEEP_VISIBLE_X}px on-screen
 * sideways and its titlebar ({@link KEEP_VISIBLE_Y}px) above the bottom, and
 * its top never rises above 0 (the titlebar lives there). Returns `g`
 * unchanged when already in range so `setGeo`'s identity guard can skip the
 * notify.
 */
export function clampToBounds(g: Geometry, bounds: Bounds): Geometry {
  const w = Math.min(Math.max(g.w, MIN_W), bounds.width);
  const h = Math.min(Math.max(g.h, MIN_H), bounds.height);
  const x = Math.min(
    Math.max(g.x, KEEP_VISIBLE_X - w),
    bounds.width - KEEP_VISIBLE_X,
  );
  const y = Math.min(Math.max(g.y, 0), bounds.height - KEEP_VISIBLE_Y);
  if (x === g.x && y === g.y && w === g.w && h === g.h) return g;
  return { ...g, x, y, w, h };
}

// Per-window state, mirroring the old per-tab geometry store: a module-global
// Map keyed by windowId + a subscriber Set fed into `useSyncExternalStore`, so
// every floating surface reading the same window stays in sync and survives
// remounts. `tabToWindow` is a derived reverse index (tabId → windowId), rebuilt
// from every window's `members` whenever the windows mutate.
const windows = new Map<WindowId, FloatingWindow>();
const tabToWindow = new Map<string, WindowId>();
const subscribers = new Set<() => void>();

/** Monotonic window-id counter (deterministic, avoids crypto in this module). */
let nextWindowId = 0;
function mintWindowId(): WindowId {
  return `w${++nextWindowId}`;
}

// Virtual-desktop state, mirroring the window store's shape: a module-global
// ordered list + the active id, both persisted alongside the windows map. Ids
// mint monotonically (`d1, d2, …`). A default `d1` is guaranteed to exist after
// `hydrate()`, so `activeDesktopId` always points at a real desktop.
let desktops: Desktop[] = [];
let activeDesktopId = "";

/** Monotonic desktop-id counter (deterministic, mirrors the window-id counter). */
let nextDesktopId = 0;
function mintDesktopId(): string {
  return `d${++nextDesktopId}`;
}

/**
 * Windows freshly *minted* this session (a new floating tab, a tear-off split) —
 * NOT hydrated from a prior session or formed by a merge. The chrome consumes the
 * flag once via {@link consumeWindowIntro} to play the window's open animation
 * exactly when it first materializes on the desktop, never on a refresh or a
 * placement round-trip.
 */
const introIds = new Set<WindowId>();

/** Consume (read-and-clear) a window's pending open-animation flag. */
export function consumeWindowIntro(id: WindowId): boolean {
  if (!introIds.has(id)) return false;
  introIds.delete(id);
  return true;
}

// Monotonic z-order counter. New windows / raise-to-front set `z = ++nextZ` to
// float above their tier-mates, then {@link reorder} compacts the open windows
// back to dense, tier-ordered ranks — so the counter never grows unbounded and
// the committed z stays `<= N` (the dock's z-overlay always sits above windows).
let nextZ = 0;

/** Rebuild the tabId → windowId reverse index from the live windows map. */
function rebuildTabIndex() {
  tabToWindow.clear();
  for (const win of windows.values()) {
    for (const tabId of win.members) tabToWindow.set(tabId, win.id);
  }
}

/**
 * The reactive whole-map snapshot returned by {@link useFloatingWindows}. It is
 * a STABLE reference between mutations (rebuilt only in {@link notify} and after
 * inserts) so `useSyncExternalStore`'s `getSnapshot` never reports a phantom
 * change and loops.
 */
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: a derived cache of the page-global `windows` map (windows are keyed by windowId and shared across every keep-alive surface mount, never per-surface), mirroring the module-global store this file is.
let snapshot: Map<WindowId, FloatingWindow> = new Map();

function rebuildSnapshot() {
  snapshot = new Map(windows);
}

/**
 * The reactive desktop-state snapshot returned by {@link useDesktops}. Like
 * {@link snapshot} it is a STABLE reference between mutations (rebuilt only in
 * {@link reindex}) so `useSyncExternalStore`'s `getSnapshot` never reports a
 * phantom change and loops.
 */
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: a derived cache of the page-global desktop list + active id (shared across every keep-alive surface mount, never per-surface), mirroring the module-global store this file is.
let desktopSnapshot: { desktops: Desktop[]; activeDesktopId: string } = {
  desktops: [],
  activeDesktopId: "",
};

function rebuildDesktopSnapshot() {
  desktopSnapshot = { desktops: [...desktops], activeDesktopId };
}

/** Recompute the reverse index + snapshots together (every structural mutation). */
function reindex() {
  rebuildTabIndex();
  rebuildSnapshot();
  rebuildDesktopSnapshot();
}

function notify() {
  reindex();
  for (const fn of subscribers) fn();
}

/**
 * Re-rank every open window to a dense `1..N` z-order with the two-tier invariant
 * baked in: unpinned windows take the low ranks, pinned ("always on top") windows
 * the high ranks, and within each tier the existing z order (focus recency) is
 * preserved. The just-bumped window (highest z in its tier) therefore lands on top
 * of its tier. Enforcing pinned-above-unpinned here — rather than via a render-time
 * z offset — keeps the committed z `<= N`, so the dock overlay (z-overlay) always
 * sits above the windows. Mutates `windows` only; the calling mint site runs
 * `persist()`/`notify()`, so this never notifies itself.
 */
function reorder() {
  const ranked = [...windows.values()].sort((a, b) => {
    const pinDelta = Number(a.geo.pinned) - Number(b.geo.pinned);
    return pinDelta !== 0 ? pinDelta : a.geo.z - b.geo.z;
  });
  ranked.forEach((win, i) =>
    windows.set(win.id, { ...win, geo: { ...win.geo, z: i + 1 } }),
  );
  nextZ = ranked.length;
}

/** The persisted shape of a window (members + active + desktop + geo). */
interface PersistedWindow {
  members: string[];
  activeTabId: string;
  desktopId: string;
  geo: Geometry;
}

/** The persisted whole-store shape (windows map + the desktop layout). */
interface PersistedStore {
  windows: Record<WindowId, PersistedWindow>;
  desktops: Desktop[];
  activeDesktopId: string;
}

const geometrySchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  z: z.number(),
  // Older sessions predate these two: `normalizeGeo` defaults them.
  pinned: z.boolean().optional(),
  minimized: z.boolean(),
  snap: z
    .custom<SnapZone>((v) => typeof v === "string")
    .nullable()
    .optional(),
  maximized: z.boolean().optional(),
  restore: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .optional(),
});

const persistedStoreSchema = z.object({
  windows: z.record(
    z.object({
      members: z.array(z.string()),
      activeTabId: z.string().optional(),
      desktopId: z.string().optional(),
      geo: geometrySchema,
    }),
  ),
  desktops: z.array(z.object({ id: z.string(), name: z.string().optional() })),
  activeDesktopId: z.string(),
});

/**
 * The window store, one entry per **app instance** (id = `appInstanceId()`):
 * window geometry is instance state, so an external navigation starts with a
 * clean desktop while a reload / back-forward finds its windows where they
 * were. See `primitives/scope/app-instance`.
 */
const windowsStore = defineStore({
  owner: "desktop.windows",
  label: "Desktop windows",
  area: "session",
  cap: "512 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: persistedStoreSchema,
  // MIGRATION (remove once no live session predates the web-storage envelope):
  // `app-windows:<tabId>:<generation>` raw payloads become entries of this
  // store. The older pre-generation `app-windows:<tabId>` has no instance to
  // belong to and is dropped, as are pre-window-grouping shapes (they fail the
  // schema).
  legacy: {
    match: (key) => key.startsWith("app-windows:"),
    adopt: (key, raw) => {
      const id = key.slice("app-windows:".length);
      if (!id.includes(":")) return null;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (err) {
        if (err instanceof SyntaxError) return null;
        throw err;
      }
      return { id, value, ts: Date.now() };
    },
  },
});

/** Whole-store serialization to session storage (per app instance, like PersistedTabs). */
function persist() {
  if (typeof window === "undefined") return;
  const record: Record<WindowId, PersistedWindow> = {};
  for (const [id, win] of windows)
    record[id] = {
      members: win.members,
      activeTabId: win.activeTabId,
      desktopId: win.desktopId,
      geo: win.geo,
    };
  const store: PersistedStore = {
    windows: record,
    desktops,
    activeDesktopId,
  };
  // A refused write (full, blocked) is reported by the store itself.
  windowsStore.write(appInstanceId(), store);
}

/**
 * Migrate the legacy `maximized` boolean (older persisted sessions) to the
 * unified `snap` field, and default the always-on-top flag, so a refresh never
 * crashes on a stale geometry shape.
 */
function normalizeGeo(geo: z.infer<typeof geometrySchema>): Geometry {
  const { maximized, ...rest } = geo;
  return {
    ...rest,
    pinned: geo.pinned ?? false,
    snap: geo.snap ?? (maximized ? "maximize" : null),
  };
}

/**
 * Mint and register the default desktop (`d1`) and make it active. Called from
 * {@link hydrate} so a default desktop always exists after first access — every
 * window can resolve a real `desktopId` and `activeDesktopId` is never empty.
 */
function ensureDefaultDesktop() {
  if (desktops.length > 0) return;
  const id = mintDesktopId();
  desktops = [{ id }];
  activeDesktopId = id;
}

// Hydrate the whole store once on first read, so cascade defaults pick up from
// the persisted count and z-order resumes above the highest stored z, and the
// desktop layout (or a freshly-minted default for legacy sessions) is restored.
let hydrated = false;
function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const read = windowsStore.read(appInstanceId());
  if (read.kind !== "value") {
    // Nothing stored for this instance (or an unreadable entry, reported by
    // the store): start from a fresh default desktop.
    ensureDefaultDesktop();
    reindex();
    return;
  }
  const store = read.value;

  // Restore the desktop layout BEFORE the windows, so `nextDesktopId` is kept
  // ahead of any persisted `d<N>` id (mirroring how `nextWindowId` is kept ahead).
  if (store.desktops.length > 0) {
    desktops = store.desktops;
    for (const d of desktops) {
      const m = /^d(\d+)$/.exec(d.id);
      if (m && Number(m[1]) > nextDesktopId) nextDesktopId = Number(m[1]);
    }
  }
  ensureDefaultDesktop();

  for (const [id, entry] of Object.entries(store.windows)) {
    const win: FloatingWindow = {
      id,
      members: entry.members,
      activeTabId: entry.activeTabId ?? entry.members[0]!,
      // A window missing `desktopId` lands on the default desktop.
      desktopId: entry.desktopId ?? activeDesktopId,
      geo: normalizeGeo(entry.geo),
    };
    windows.set(win.id, win);
    if (win.geo.z > nextZ) nextZ = win.geo.z;
    // Keep the id counter ahead of any persisted `w<N>` id so fresh windows
    // never collide with a hydrated one.
    const m = /^w(\d+)$/.exec(win.id);
    if (m && Number(m[1]) > nextWindowId) nextWindowId = Number(m[1]);
  }

  // Restore the active desktop only if it still names a real desktop; else fall
  // back to the first, so `activeDesktopId` always points at an existing one.
  if (desktops.some((d) => d.id === store.activeDesktopId))
    activeDesktopId = store.activeDesktopId;

  reindex();
}

/**
 * First access for an unknown window cascades it down-right from the prior ones
 * (`40 + n*28`) and assigns the next z, so freshly opened windows never land
 * exactly on top of an existing one.
 */
function defaultGeometry(): Geometry {
  const n = windows.size;
  return {
    x: 40 + n * 28,
    y: 40 + n * 28,
    w: 880,
    h: 600,
    z: ++nextZ,
    pinned: false,
    minimized: false,
    snap: null,
  };
}

/**
 * Resolve (auto-creating) the window holding `tabId`. On first read for an
 * unknown tab a singleton window is minted with a cascade default box, then
 * {@link reorder} settles it onto the top of the unpinned tier; the snapshot is
 * refreshed so the new window appears in {@link useFloatingWindows} before any
 * notify.
 */
function readWindowForTab(tabId: string): FloatingWindow {
  hydrate();
  const existing = tabToWindow.get(tabId);
  if (existing) return windows.get(existing)!;
  const id = mintWindowId();
  introIds.add(id);
  windows.set(id, {
    id,
    members: [tabId],
    activeTabId: tabId,
    desktopId: activeDesktopId,
    geo: defaultGeometry(),
  });
  reorder();
  persist();
  reindex();
  return windows.get(id)!;
}

type GeometryUpdater = Geometry | ((g: Geometry) => Geometry);

/** Imperative resolver: which window currently holds `tabId` (commands / menu). */
export function windowForTab(tabId: string): WindowId | undefined {
  hydrate();
  return tabToWindow.get(tabId);
}

/** Imperative read of a window by id (commands / menu). */
export function getFloatingWindow(
  windowId: WindowId,
): FloatingWindow | undefined {
  hydrate();
  return windows.get(windowId);
}

/** Imperative read of every window (commands laying several out at once). */
export function getFloatingWindows(): ReadonlyMap<WindowId, FloatingWindow> {
  hydrate();
  return snapshot;
}

/**
 * Detach `tabId` from its current window. If that window empties it is deleted;
 * otherwise its `activeTabId` is repaired to a surviving neighbour (preferring
 * the prior sibling, else the new first member). Pure structural mutation —
 * the caller persists + notifies. Returns the (possibly removed) source window's
 * id so callers can reason about cascading effects.
 */
function detachFromCurrent(tabId: string): WindowId | undefined {
  const sourceId = tabToWindow.get(tabId);
  if (!sourceId) return undefined;
  const source = windows.get(sourceId);
  if (!source) return sourceId;
  const idx = source.members.indexOf(tabId);
  const remaining = source.members.filter((m) => m !== tabId);
  if (remaining.length === 0) {
    windows.delete(sourceId);
    return sourceId;
  }
  // Repair the active member if we just removed it: take the prior sibling
  // (clamped) so focus lands on a neighbour, like closing a browser tab.
  const activeTabId =
    source.activeTabId === tabId
      ? remaining[Math.min(idx, remaining.length - 1)]!
      : source.activeTabId;
  windows.set(sourceId, { ...source, members: remaining, activeTabId });
  return sourceId;
}

/**
 * Move `tabId` into `targetWindowId` (its new tab strip), inserting at `atIndex`
 * (default end) and making it the shown member. Detaches it from its current
 * window first (deleting/repairing that window as needed), then raises the target
 * to the front so the merge result is focused. No-op when the tab is already the
 * sole member of the target at that position is not special-cased — re-inserting
 * is idempotent in effect.
 */
export function mergeTabIntoWindow(
  tabId: string,
  targetWindowId: WindowId,
  atIndex?: number,
) {
  hydrate();
  const target = windows.get(targetWindowId);
  if (!target) return;
  detachFromCurrent(tabId);
  // Re-read the target: detach may have repaired it (if tab came from it).
  const current = windows.get(targetWindowId);
  if (!current) return;
  const members = current.members.filter((m) => m !== tabId);
  const index = atIndex ?? members.length;
  members.splice(Math.max(0, Math.min(index, members.length)), 0, tabId);
  windows.set(targetWindowId, { ...current, members, activeTabId: tabId });
  // Persist + notify the structural change first; bringWindowToFront only
  // re-ranks z and is a no-op when the target is already topmost (e.g. when the
  // source window was just deleted, leaving the target alone) — so it can't be
  // relied on to flush this mutation.
  persist();
  notify();
  bringWindowToFront(targetWindowId);
}

/**
 * Tear `tabId` out of its current window into a fresh singleton window. When a
 * `box` is given the new window is placed there (its origin, and its size when
 * given — the tear-off preview's); otherwise it cascades from the window count. The new window lands on
 * top. No-op when the tab is already the lone member of its window.
 */
export function splitTabToNewWindow(
  tabId: string,
  box?: { x: number; y: number; w?: number; h?: number },
) {
  hydrate();
  const sourceId = tabToWindow.get(tabId);
  const source = sourceId ? windows.get(sourceId) : undefined;
  // Already its own singleton window — nothing to split off.
  if (source && source.members.length === 1) return;
  detachFromCurrent(tabId);
  const id = mintWindowId();
  introIds.add(id);
  const geo = defaultGeometry();
  windows.set(id, {
    id,
    members: [tabId],
    activeTabId: tabId,
    desktopId: activeDesktopId,
    geo: box ? { ...geo, ...box } : geo,
  });
  reorder();
  persist();
  notify();
}

/** Set a window's shown member (no-op when already active or not a member). */
export function setActiveMember(windowId: WindowId, tabId: string) {
  hydrate();
  const win = windows.get(windowId);
  if (!win || win.activeTabId === tabId || !win.members.includes(tabId)) return;
  windows.set(windowId, { ...win, activeTabId: tabId });
  persist();
  notify();
}

/** Reorder `tabId` to `atIndex` within its window's member strip (no-op if absent). */
export function reorderMember(
  windowId: WindowId,
  tabId: string,
  atIndex: number,
) {
  hydrate();
  const win = windows.get(windowId);
  if (!win) return;
  const from = win.members.indexOf(tabId);
  if (from === -1) return;
  const members = win.members.filter((m) => m !== tabId);
  members.splice(Math.max(0, Math.min(atIndex, members.length)), 0, tabId);
  windows.set(windowId, { ...win, members });
  persist();
  notify();
}

/**
 * Reconcile every window against the surface's exit-presence sets, so a closed
 * tab's window doesn't linger (and re-appear if a new tab reuses its slot) — yet
 * a window mid-exit-tween is never pruned out from under its still-animating
 * chrome. `liveTabIds` are the tabs still in the store; `retainedTabIds` are the
 * live tabs PLUS those the host is retaining for an exit tween (a superset of
 * `liveTabIds`). Called from the floating Foreground keyed on the retained id set.
 *
 * Per-window, mirroring the surface's exit-presence refinement:
 *  - **≥1 LIVE member:** prune members down to the live ones immediately and
 *    repair a dropped `activeTabId` to a surviving LIVE member — so closing the
 *    active chip of a multi-tab window instantly reveals a sibling (no dead
 *    frame). The just-closed member's container is still retained by the host but
 *    is now inactive, so its chrome returns null (invisible) before it unmounts.
 *  - **0 live but ≥1 RETAINED member:** leave the window fully intact (members +
 *    geometry + activeTabId) so its active member can play the whole-window exit
 *    tween. Do NOT delete or empty it.
 *  - **0 live and 0 retained:** delete it (and persist), as before.
 */
export function pruneWindows(
  liveTabIds: Set<string>,
  retainedTabIds: Set<string>,
) {
  hydrate();
  let changed = false;
  for (const [id, win] of [...windows]) {
    const live = win.members.filter((m) => liveTabIds.has(m));
    if (live.length > 0) {
      // ≥1 live member: prune to the live set now (reveals a sibling instantly).
      if (live.length === win.members.length) continue;
      changed = true;
      const activeTabId = live.includes(win.activeTabId)
        ? win.activeTabId
        : live[0]!;
      windows.set(id, { ...win, members: live, activeTabId });
      continue;
    }
    // 0 live members: keep intact while any member is still retained (exiting) so
    // its active member can animate the whole-window exit; otherwise delete.
    const stillRetained = win.members.some((m) => retainedTabIds.has(m));
    if (stillRetained) continue;
    changed = true;
    windows.delete(id);
  }
  if (changed) {
    persist();
    notify();
  }
}

/**
 * Raise a window to the top of its own tier (module-level so the dock can call it
 * without a geometry handle). A pinned window rises above other pinned windows; an
 * unpinned one rises above other unpinned windows but stays below any always-on-top
 * window. No-op when already topmost in its tier — so repeated pointer-downs inside
 * the focused window never churn the z-order. Mints the new z, then {@link reorder}
 * compacts back to dense, tier-ordered ranks with this window on top of its tier.
 */
export function bringWindowToFront(windowId: WindowId) {
  hydrate();
  const current = windows.get(windowId);
  if (!current) return;
  // Topmost in its tier already? Every same-tier window sits at or below it.
  const topOfTier = [...windows.values()].every(
    (w) => w.geo.pinned !== current.geo.pinned || w.geo.z <= current.geo.z,
  );
  if (topOfTier) return;
  windows.set(windowId, { ...current, geo: { ...current.geo, z: ++nextZ } });
  reorder();
  persist();
  notify();
}

/**
 * Toggle a window's "always on top" flag (module-level so chrome / shortcuts can
 * call it without a geometry handle). Bumps the window so it lands on top of its
 * NEW tier, then {@link reorder} re-ranks so pinned windows sit above unpinned ones.
 */
export function toggleWindowPin(windowId: WindowId) {
  hydrate();
  const current = windows.get(windowId);
  if (!current) return;
  windows.set(windowId, {
    ...current,
    geo: { ...current.geo, pinned: !current.geo.pinned, z: ++nextZ },
  });
  reorder();
  persist();
  notify();
}

/**
 * Set a window's `minimized` flag (default un-minimize). Module-level so the dock
 * can restore/minimize a window without a geometry handle. No-op when unchanged
 * so it never notifies spuriously.
 */
export function restoreWindow(windowId: WindowId, minimize = false) {
  hydrate();
  const current = windows.get(windowId);
  if (!current || current.geo.minimized === minimize) return;
  windows.set(windowId, {
    ...current,
    geo: { ...current.geo, minimized: minimize },
  });
  persist();
  notify();
}

/**
 * Place several windows at free boxes in one commit (the overview's "tile
 * all", a lone tab dragged out moving its window): each leaves any snap, its
 * previous free box kept as `restore` (mockup `tileAll`), and the fields given
 * replace its box. Unknown ids are skipped.
 */
export function placeWindows(
  boxes: ReadonlyMap<
    WindowId,
    { x: number; y: number; w?: number; h?: number }
  >,
) {
  hydrate();
  let changed = false;
  for (const [id, box] of boxes) {
    const win = windows.get(id);
    if (!win) continue;
    const g = win.geo;
    windows.set(id, {
      ...win,
      geo: {
        ...g,
        ...box,
        snap: null,
        restore: { x: g.x, y: g.y, w: g.w, h: g.h },
      },
    });
    changed = true;
  }
  if (!changed) return;
  persist();
  notify();
}

/** Minimise every given window in one commit (mockup "Minimise all windows"). */
export function minimizeWindows(ids: Iterable<WindowId>) {
  setWindowsMinimized(ids, true);
}

/** Un-minimise every given window in one commit (show desktop, toggled back). */
export function unminimizeWindows(ids: Iterable<WindowId>) {
  setWindowsMinimized(ids, false);
}

function setWindowsMinimized(ids: Iterable<WindowId>, minimized: boolean) {
  hydrate();
  let changed = false;
  for (const id of ids) {
    const win = windows.get(id);
    if (!win || win.geo.minimized === minimized) continue;
    windows.set(id, { ...win, geo: { ...win.geo, minimized } });
    changed = true;
  }
  if (!changed) return;
  persist();
  notify();
}

/**
 * Apply a keyboard tiling nudge to a window (module-level so static
 * window-management shortcuts can drive the focused window without a geometry
 * handle). The {@link nextSnapAction} state machine turns the current snap +
 * direction into the next tile, a restore-to-free, or a minimize — mirroring the
 * zones the mouse drag produces. A snap always un-minimizes; nudging a minimized
 * window also raises it so it lands on top like a fresh focus.
 */
export function snapWindowDirection(windowId: WindowId, dir: SnapDirection) {
  hydrate();
  const current = windows.get(windowId);
  if (!current) return;
  const action = nextSnapAction(current.geo.snap, dir);
  if (action.type === "minimize") {
    restoreWindow(windowId, /* minimize */ true);
    return;
  }
  const { zone } = action;
  const geo = current.geo;
  const nextGeo: Geometry =
    zone === null
      ? // Restore to the stashed free box (matching the chrome's maximize toggle).
        {
          ...geo,
          snap: null,
          ...(geo.restore ?? {}),
          restore: undefined,
          minimized: false,
        }
      : {
          ...geo,
          snap: zone,
          // Keep an existing free box; only capture one when leaving the free state.
          restore: geo.restore ?? { x: geo.x, y: geo.y, w: geo.w, h: geo.h },
          minimized: false,
        };
  windows.set(windowId, { ...current, geo: nextGeo });
  persist();
  notify();
  if (geo.minimized) bringWindowToFront(windowId);
}

/**
 * Mint a new virtual desktop, appended to the end of the list. With
 * `activate: true` it becomes the active desktop (the workspace-pager "+" path);
 * otherwise the active desktop is unchanged (e.g. moving a window past the last
 * desktop creates one without yanking the user there). Returns the new id.
 */
export function createDesktop(opts?: { activate?: boolean }): string {
  hydrate();
  const id = mintDesktopId();
  desktops = [...desktops, { id }];
  if (opts?.activate) activeDesktopId = id;
  persist();
  notify();
  return id;
}

/**
 * Remove a virtual desktop. No-op when it's the last desktop (there is always at
 * least one). Every window on it is reassigned to the adjacent desktop (the prior
 * one in list order, else the next); if the removed desktop was active, the same
 * neighbour becomes active so the user lands on the windows that just moved.
 */
export function removeDesktop(id: string) {
  hydrate();
  if (desktops.length <= 1) return;
  const idx = desktops.findIndex((d) => d.id === id);
  if (idx === -1) return;
  const neighbour = desktops[idx - 1] ?? desktops[idx + 1]!;
  for (const [wid, win] of windows)
    if (win.desktopId === id)
      windows.set(wid, { ...win, desktopId: neighbour.id });
  desktops = desktops.filter((d) => d.id !== id);
  if (activeDesktopId === id) activeDesktopId = neighbour.id;
  persist();
  notify();
}

/** Switch the active desktop (no-op if unknown or already active). */
export function setActiveDesktop(id: string) {
  hydrate();
  if (id === activeDesktopId || !desktops.some((d) => d.id === id)) return;
  activeDesktopId = id;
  persist();
  notify();
}

/** Reassign a window to a desktop (no-op if the window/desktop is unknown or unchanged). */
export function moveWindowToDesktop(windowId: WindowId, desktopId: string) {
  hydrate();
  const win = windows.get(windowId);
  if (!win || win.desktopId === desktopId) return;
  if (!desktops.some((d) => d.id === desktopId)) return;
  windows.set(windowId, { ...win, desktopId });
  persist();
  notify();
}

/**
 * The highest-`z`, non-minimized window on a desktop (the focus target when
 * switching to it). Returns undefined when the desktop has no non-minimized
 * window — an empty (or all-minimized) desktop simply gets no focus on switch.
 */
export function topmostWindowOnDesktop(id: string): FloatingWindow | undefined {
  hydrate();
  let top: FloatingWindow | undefined;
  for (const win of windows.values()) {
    if (win.desktopId !== id || win.geo.minimized) continue;
    if (!top || win.geo.z > top.geo.z) top = win;
  }
  return top;
}

/** Imperative read of the desktop layout (commands), mirroring {@link getFloatingWindow}. */
export function getDesktopsState(): {
  desktops: Desktop[];
  activeDesktopId: string;
} {
  hydrate();
  return { desktops, activeDesktopId };
}

/**
 * Reactive read of the virtual-desktop layout (pager / chrome). Returns the
 * module desktop snapshot — a stable reference between mutations (rebuilt only in
 * `reindex`), so `useSyncExternalStore` never sees a phantom change.
 */
export function useDesktops(): {
  desktops: Desktop[];
  activeDesktopId: string;
} {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    // Hydrate on first read so the default desktop exists before first paint
    // (mirrors `useTabWindow`, whose getSnapshot resolves through `hydrate`); the
    // returned reference stays stable between mutations so the store never loops.
    () => readDesktopSnapshot(),
    () => desktopSnapshot,
  );
}

/** Hydrate-then-read the desktop snapshot (the client getSnapshot for {@link useDesktops}). */
function readDesktopSnapshot(): {
  desktops: Desktop[];
  activeDesktopId: string;
} {
  hydrate();
  return desktopSnapshot;
}

/**
 * Reactive read of the whole windows map (for the dock). Returns the module
 * snapshot — a stable reference between mutations (rebuilt only in `notify` and
 * after inserts), so `useSyncExternalStore` never sees a phantom change.
 */
export function useFloatingWindows(): Map<WindowId, FloatingWindow> {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** The reactive window handle a {@link useTabWindow} reader receives. */
export interface TabWindowHandle {
  /** The window currently holding this tab (auto-created on first read). */
  window: FloatingWindow;
  /** Whether this tab is the window's shown member. */
  isActive: boolean;
  /** Mutate this window's geometry box (value or functional updater). */
  setGeo: (next: GeometryUpdater) => void;
  /** Raise this window above its tier-mates. */
  bringToFront: () => void;
}

/**
 * Per-tab window handle, mirroring the old `useWindowGeometry`: resolves (and
 * auto-creates) the window holding `tabId`, exposing its geometry setter and a
 * raise-to-front. `isActive` is `window.activeTabId === tabId`, so an inactive
 * group member can hide itself while staying mounted. Every mutation persists the
 * whole map and notifies subscribers.
 */
export function useTabWindow(tabId: string): TabWindowHandle {
  const window = useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => readWindowForTab(tabId),
    () => readWindowForTab(tabId),
  );

  // Stable callbacks (keyed only on tabId): consumers push these into effect deps
  // / state, so an unstable identity per render would loop. A store handle must
  // return steady references. `setGeo` resolves the window by tab at call time, so
  // it stays correct even if the tab is later merged into a different window.
  const setGeo = useCallback(
    (next: GeometryUpdater) => {
      const win = readWindowForTab(tabId);
      const value = typeof next === "function" ? next(win.geo) : next;
      if (value === win.geo) return;
      windows.set(win.id, { ...win, geo: value });
      persist();
      notify();
    },
    [tabId],
  );

  const bringToFront = useCallback(() => {
    const id = tabToWindow.get(tabId);
    if (id) bringWindowToFront(id);
  }, [tabId]);

  return {
    window,
    isActive: window.activeTabId === tabId,
    setGeo,
    bringToFront,
  };
}
