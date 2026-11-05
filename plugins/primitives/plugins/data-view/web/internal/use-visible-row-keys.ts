import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createInViewWatcher } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import type { DataViewVisibleRows } from "../../core";

/**
 * The keys of the rows a DataView has on screen: `measuring` until a settled
 * measurement of the rows drawn NOW (see {@link useVisibleRowKeys}), then the
 * set of `[data-row-key]` elements under the container that intersect the
 * viewport.
 */
export type VisibleRowKeys = "measuring" | ReadonlySet<string>;

/** What the rows on screen say: which they are, and how much room each takes. */
export interface RowsOnScreen {
  keys: VisibleRowKeys;
  /**
   * Each row's ADVANCE, by key, in px: the distance from its top to the top
   * of the next entry of its read (a row or a placeholder), measured whenever
   * both are drawn — so a row's advance is exactly the room it takes in the
   * layout (a list's row height, a gallery's line height on the line's last
   * card and 0 on the others, a group header between two rows counted with
   * the row above it). Kept for every row of the current reads that was
   * ever measured, drawn or not — a windowed list's rows above the window
   * keep the advance they were last drawn at. What a placeholder of released
   * rows is sized by (`usePlaceholderHeights`).
   */
  advances: ReadonlyMap<string, number>;
  /**
   * The mean advance of the rows measured at the last settle that measured
   * any (kept across epochs: the rows change, their size does not); `null`
   * before one did. The fallback for rows never measured.
   */
  rowPitch: number | null;
}

/**
 * The attribute marking a page placeholder beside its `data-row-key` — what
 * tells it apart from a row where both are measured (the row pitch, the
 * scroll anchor).
 */
export const PAGE_PLACEHOLDER_ATTR = "data-page-placeholder";

/**
 * How long the rows on screen must hold still before they count: a fling
 * crosses every row on its way, and a page it only flew past is not one the
 * user is looking at.
 */
const SETTLE_MS = 250;
/**
 * The longest a change waits for the rows to hold still: a list whose rows
 * never do (a busy feed taking inserts at the head) still publishes this
 * often, so its viewport cannot freeze at the last quiet moment.
 */
const MAX_WAIT_MS = 1000;
const ROW_SELECTOR = "[data-row-key]";

/** A measurement, and the rows it was taken over. */
interface Measured {
  epoch: string;
  keys: ReadonlySet<string>;
}

/**
 * Which rows under `container` are on screen — every view marks each row it
 * draws with `data-row-key` (the row key), so one watcher serves every view,
 * windowed or not. Push-based: an IntersectionObserver over the rows (through
 * the `in-view` primitive), which delivers an entry for each row it is handed
 * and each crossing after; a MutationObserver only ENROLLS the rows a view
 * mounts (a windowed list mounts them as it scrolls). Each entry re-arms ONE
 * settle timer, which publishes `SETTLE_MS` after the last change, and at
 * most `MAX_WAIT_MS` after the first one it has not published.
 *
 * `reads` are the keys of each paged read the rows belong to, in each read's
 * order (rows and the placeholders between them); `null` (nothing paged
 * under it) builds nothing. Their keys are the EPOCH the measurement is
 * matched against: a measurement is only ever handed out for the epoch it
 * was taken in, and only once it can vouch for what is drawn:
 * - a new epoch is `measuring` until a settle that ran after its rows were
 *   committed — an older measurement says nothing about rows that were not
 *   there yet (a head that just landed is not "off screen");
 * - a settle waits while a row it enrolled has had no entry yet (its first
 *   one is on its way);
 * - with no row drawn at all there is nothing to measure — it stays
 *   `measuring` (a skeleton, a view that marks no row), never an empty set.
 *
 * Each settle also measures the ADVANCE of every drawn row whose next entry
 * in its read is drawn too (see {@link RowsOnScreen.advances}).
 */
export function useVisibleRowKeys(
  container: HTMLElement | null,
  reads: readonly (readonly string[])[] | null,
): RowsOnScreen {
  const epoch = useMemo(
    () =>
      reads === null ? null : reads.map((k) => k.join("\n")).join("\u0000"),
    [reads],
  );
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [sizes, setSizes] = useState<Sizes>(NO_SIZES);
  const epochRef = useRef(epoch);
  const readsRef = useRef(reads);
  const settleRef = useRef<(() => void) | null>(null);
  const enabled = epoch !== null;
  useEffect(() => {
    if (!enabled || container === null) return;
    const intersecting = new Set<Element>();
    /** Enrolled rows still waiting for their first entry. */
    const unmeasured = new Set<Element>();
    const enrolled = new WeakSet<Element>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** When the oldest change not yet published happened. */
    let pendingSince: number | null = null;
    const publish = () => {
      timer = null;
      for (const el of unmeasured) if (!el.isConnected) unmeasured.delete(el);
      // A row's first entry is on its way: it will settle again.
      if (unmeasured.size > 0) return;
      const ep = epochRef.current;
      if (ep === null) return;
      // Nothing drawn: nothing to say about the rows (not "none of them").
      if (container.querySelector(ROW_SELECTOR) === null) return;
      pendingSince = null;
      const next = new Set<string>();
      for (const el of intersecting) {
        // A row unmounted since it was seen: gone from the screen.
        if (!el.isConnected) {
          intersecting.delete(el);
          continue;
        }
        const key = el.getAttribute("data-row-key");
        if (key !== null) next.add(key);
      }
      setMeasured((prev) =>
        prev !== null && prev.epoch === ep && sameKeys(prev.keys, next)
          ? prev
          : { epoch: ep, keys: next },
      );
      const reads = readsRef.current;
      // No read's keys (a row read alone asked for the measurement): no
      // advances to measure.
      if (reads !== null && reads.length > 0) {
        const measuredNow = advancesOf(container, reads);
        setSizes((prev) => nextSizes(prev, reads, measuredNow));
      }
    };
    const settle = () => {
      const now = Date.now();
      pendingSince ??= now;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(
        publish,
        Math.max(0, Math.min(SETTLE_MS, pendingSince + MAX_WAIT_MS - now)),
      );
    };
    const watcher = createInViewWatcher((entries) => {
      for (const e of entries) {
        unmeasured.delete(e.target);
        if (e.isIntersecting) intersecting.add(e.target);
        else intersecting.delete(e.target);
      }
      settle();
    });
    const enroll = (el: Element) => {
      if (enrolled.has(el)) return;
      enrolled.add(el);
      unmeasured.add(el);
      watcher.observe(el);
    };
    const enrollUnder = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(ROW_SELECTOR)) enroll(node);
      node.querySelectorAll(ROW_SELECTOR).forEach(enroll);
    };
    enrollUnder(container);
    const mutations = new MutationObserver((records) => {
      let rekeyed = false;
      for (const r of records) {
        if (r.type === "attributes") {
          // A row re-keyed in place: no crossing reports it.
          enrollUnder(r.target);
          rekeyed = true;
        } else {
          r.addedNodes.forEach(enrollUnder);
        }
      }
      if (rekeyed) settle();
    });
    mutations.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-row-key"],
    });
    settleRef.current = settle;
    settle();
    return () => {
      settleRef.current = null;
      if (timer !== null) clearTimeout(timer);
      mutations.disconnect();
      watcher.disconnect();
    };
  }, [container, enabled]);
  // A new epoch: re-measure — in the commit, so no settle armed before its
  // rows were drawn can publish under it.
  useLayoutEffect(() => {
    epochRef.current = epoch;
    settleRef.current?.();
  }, [epoch]);
  useLayoutEffect(() => {
    readsRef.current = reads;
  }, [reads]);
  const keys =
    measured !== null && epoch !== null && measured.epoch === epoch
      ? measured.keys
      : "measuring";
  const { advances, rowPitch } = sizes;
  return useMemo(
    () => ({ keys, advances, rowPitch }),
    [keys, advances, rowPitch],
  );
}

/** The advances kept, and the pitch of the last settle that measured any. */
interface Sizes {
  advances: ReadonlyMap<string, number>;
  rowPitch: number | null;
}

const NO_SIZES: Sizes = { advances: new Map(), rowPitch: null };

/**
 * The advance of every drawn row whose next entry in its read is drawn too:
 * the next entry's top minus the row's. One element per row: a row stamped
 * twice (a drag wrapper around the row's own box) counts as its outer
 * element. A pair with an element not laid out (an empty box) says nothing.
 */
function advancesOf(
  host: HTMLElement,
  reads: readonly (readonly string[])[],
): Map<string, number> {
  const tops = new Map<string, { top: number; placeholder: boolean }>();
  for (const el of host.querySelectorAll(ROW_SELECTOR)) {
    const key = el.getAttribute("data-row-key")!;
    if (tops.has(key)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    tops.set(key, {
      top: rect.top,
      placeholder: el.hasAttribute(PAGE_PLACEHOLDER_ATTR),
    });
  }
  const out = new Map<string, number>();
  for (const keys of reads) {
    for (let i = 0; i + 1 < keys.length; i++) {
      const row = tops.get(keys[i]!);
      const next = tops.get(keys[i + 1]!);
      if (row === undefined || next === undefined || row.placeholder) continue;
      const advance = next.top - row.top;
      if (advance >= 0) out.set(keys[i]!, advance);
    }
  }
  return out;
}

/**
 * The advances after a settle: those just measured, over those kept for the
 * rows still in the reads (a row released from every read is forgotten).
 */
function nextSizes(
  prev: Sizes,
  reads: readonly (readonly string[])[],
  measured: ReadonlyMap<string, number>,
): Sizes {
  const advances = new Map<string, number>();
  for (const keys of reads) {
    for (const k of keys) {
      const a = measured.get(k) ?? prev.advances.get(k);
      if (a !== undefined) advances.set(k, a);
    }
  }
  let sum = 0;
  for (const a of measured.values()) sum += a;
  const rowPitch =
    measured.size > 0 && sum > 0 ? sum / measured.size : prev.rowPitch;
  return sameAdvances(prev.advances, advances) && rowPitch === prev.rowPitch
    ? prev
    : { advances, rowPitch };
}

function sameAdvances(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/**
 * The visible rows of one paged read, in its order: the first and last of
 * `keys` (the read's rows, in order) that are on screen — or none of them.
 */
export function visibleRowsOf(
  keys: readonly string[],
  visible: ReadonlySet<string>,
): DataViewVisibleRows {
  let first = -1;
  let last = -1;
  keys.forEach((k, i) => {
    if (!visible.has(k)) return;
    if (first === -1) first = i;
    last = i;
  });
  return first === -1
    ? { kind: "none" }
    : { kind: "rows", first: keys[first]!, last: keys[last]! };
}
