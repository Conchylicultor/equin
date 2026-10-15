/** A row a disclosure hid, still drawn while it folds away. */
export interface FoldingRow<T> {
  key: string;
  item: T;
  /**
   * The key of the row it followed in the old list that the new list still
   * has — where it is drawn until it has folded away. `null`: it came before
   * every surviving row.
   */
  after: string | null;
}

/**
 * What one disclosure did to a flat list: the rows it revealed (now in the
 * list, absent before) and the rows it hid (in the list before, gone now).
 * A list's other changes in the same commit ride along — telling a revealed
 * row from a live insert landing in the same frame is not worth a model.
 */
export interface RowDisclosure<T> {
  revealed: ReadonlySet<string>;
  hidden: readonly FoldingRow<T>[];
}

type GetKey<T> = (item: T, index: number) => string;

/**
 * Whether `prev → next` is a disclosure, and what it revealed and hid.
 *
 * A change of the list is a disclosure when a disclosure OPENED or CLOSED in
 * the same commit: a key whose membership in the open set flipped, and which
 * is not a row that itself appeared or vanished — a row inserted already
 * expanded, or deleted while expanded, is live data, not a toggle. Every other
 * change (scrolling a window, a search narrowing, live inserts, a page
 * arriving) leaves the open set alone and is no disclosure: `null`. So is a
 * disclosure that changed nothing drawn (a toggle under a search that holds
 * the subtree open).
 *
 * `openKeys` lives in the owner's own key space — a tree's expanded node ids,
 * a table's open group or fold keys; only its flips are read.
 */
export function detectDisclosure<T>({
  prevItems,
  nextItems,
  prevOpen,
  nextOpen,
  getKey,
}: {
  prevItems: readonly T[];
  nextItems: readonly T[];
  prevOpen: ReadonlySet<string>;
  nextOpen: ReadonlySet<string>;
  getKey: GetKey<T>;
}): RowDisclosure<T> | null {
  if (prevItems === nextItems) return null;
  const flipped = symmetricDifference(prevOpen, nextOpen);
  if (flipped.length === 0) return null;

  const prevKeys = prevItems.map(getKey);
  const nextKeys = nextItems.map(getKey);
  const prevSet = new Set(prevKeys);
  const nextSet = new Set(nextKeys);
  const toggled = flipped.some((key) => prevSet.has(key) === nextSet.has(key));
  if (!toggled) return null;

  const revealed = new Set(nextKeys.filter((key) => !prevSet.has(key)));
  const hidden: FoldingRow<T>[] = [];
  let after: string | null = null;
  prevKeys.forEach((key, i) => {
    if (nextSet.has(key)) after = key;
    else hidden.push({ key, item: prevItems[i]!, after });
  });
  if (revealed.size === 0 && hidden.length === 0) return null;
  return { revealed, hidden };
}

/**
 * A toggle's reveal still on its way: the lines it opened that show no rows
 * yet — nothing after them, or only STAND-INS (a lazy node's "Loading…"
 * placeholder, a live section's footer: lines the owner draws in place of rows
 * not listed yet) — and those stand-ins. An opened line waits until rows land
 * straight after it, however many other changes come first (a live list keeps
 * changing elsewhere); a line whose toggle revealed real rows waits for
 * nothing, so a row inserted there later is live data.
 */
export interface AwaitedReveal {
  after: ReadonlySet<string>;
  standIns: ReadonlySet<string>;
}

export const NOTHING_AWAITED: AwaitedReveal = {
  after: new Set(),
  standIns: new Set(),
};

/** Whether a line stands in for rows not listed yet. */
export type IsStandIn<T> = (item: T) => boolean;

/** What a toggle (`prevOpen → nextOpen`, revealing `revealed`) still awaits. */
export function awaitedReveal<T>({
  nextItems,
  prevOpen,
  nextOpen,
  revealed,
  getKey,
  isStandIn,
}: {
  nextItems: readonly T[];
  prevOpen: ReadonlySet<string>;
  nextOpen: ReadonlySet<string>;
  revealed: ReadonlySet<string>;
  getKey: GetKey<T>;
  isStandIn: IsStandIn<T>;
}): AwaitedReveal {
  const opened = new Set([...nextOpen].filter((key) => !prevOpen.has(key)));
  const after = new Set<string>();
  const standIns = new Set<string>();
  const keys = nextItems.map(getKey);
  keys.forEach((key, i) => {
    if (!opened.has(key)) return;
    // What the toggle revealed straight after the line it opened.
    let real = false;
    for (let k = i + 1; k < keys.length && revealed.has(keys[k]!); k++) {
      if (isStandIn(nextItems[k]!)) standIns.add(keys[k]!);
      else real = true;
    }
    if (!real) after.add(key);
  });
  return { after, standIns };
}

/**
 * Whether `prev → next` brings an awaited reveal — a change with no flip of
 * its own, so `detectDisclosure` calls it live data: a lazy node's children
 * replacing its placeholder one listing later, a live section's rows arriving
 * with its query.
 *
 * The rows it inserts straight after an awaited line, or right where an
 * awaited stand-in stood (which it removed), are revealed and those stand-ins
 * hidden — the placeholder folds out as the children fold in. Rows inserted
 * anywhere else are live data, as ever. Returns the disclosure (or `null`)
 * and what is still awaited after it: a line that got real rows is done.
 */
export function detectContinuation<T>({
  prevItems,
  nextItems,
  awaited,
  getKey,
  isStandIn,
}: {
  prevItems: readonly T[];
  nextItems: readonly T[];
  awaited: AwaitedReveal;
  getKey: GetKey<T>;
  isStandIn: IsStandIn<T>;
}): { disclosure: RowDisclosure<T> | null; awaited: AwaitedReveal } {
  if (
    prevItems === nextItems ||
    (awaited.after.size === 0 && awaited.standIns.size === 0)
  )
    return { disclosure: null, awaited };
  const prevKeys = prevItems.map(getKey);
  const nextKeys = nextItems.map(getKey);
  const prevSet = new Set(prevKeys);
  const nextSet = new Set(nextKeys);

  // The stand-ins this change removed, each at its slot: after the surviving
  // line it followed.
  const hidden: FoldingRow<T>[] = [];
  let anchor: string | null = null;
  prevKeys.forEach((key, i) => {
    if (nextSet.has(key)) anchor = key;
    else if (awaited.standIns.has(key))
      hidden.push({ key, item: prevItems[i]!, after: anchor });
  });
  // An awaited line's slot runs on through the stand-ins after it (a footer
  // stays below the rows that land above it).
  const slots = new Set<string | null>([
    ...awaited.after,
    ...hidden.map((row) => row.after),
  ]);

  // The lines inserted inside a slot, and the slots that got real rows.
  const revealed = new Set<string>();
  const filled = new Set<string | null>();
  let slot: string | null | undefined = slots.has(null) ? null : undefined;
  nextKeys.forEach((key, i) => {
    if (prevSet.has(key)) {
      slot = slots.has(key)
        ? key
        : slot !== undefined && awaited.standIns.has(key)
          ? slot
          : undefined;
      return;
    }
    if (slot === undefined) return;
    revealed.add(key);
    if (!isStandIn(nextItems[i]!)) filled.add(slot);
  });
  // The stand-ins still drawn (old ones not replaced, and any this change
  // inserted) keep waiting.
  const standIns = new Set<string>();
  nextKeys.forEach((key, i) => {
    if (
      (awaited.standIns.has(key) || revealed.has(key)) &&
      isStandIn(nextItems[i]!)
    )
      standIns.add(key);
  });
  const next: AwaitedReveal = {
    after: new Set([...awaited.after].filter((key) => !filled.has(key))),
    standIns,
  };
  return {
    disclosure: revealed.size > 0 ? { revealed, hidden } : null,
    awaited: next,
  };
}

/**
 * `items` with the disclosure's hidden rows put back where they were — each
 * after the surviving row it followed — so they stay drawn, and the rows after
 * them stay put, while they fold away.
 */
export function withFoldingRows<T>(
  items: readonly T[],
  disclosure: RowDisclosure<T>,
  getKey: GetKey<T>,
): readonly T[] {
  if (disclosure.hidden.length === 0) return items;
  const present = new Set(items.map(getKey));
  const byAnchor = new Map<string | null, T[]>();
  for (const row of disclosure.hidden) {
    // Back already (re-opened by a later commit): drawn once, as itself.
    if (present.has(row.key)) continue;
    // An anchor that live data removed mid-fold is never reached below, so its
    // rows simply stop drawing — there is nothing left for them to fold from.
    const list = byAnchor.get(row.after) ?? [];
    list.push(row.item);
    byAnchor.set(row.after, list);
  }
  const out: T[] = [...(byAnchor.get(null) ?? [])];
  items.forEach((item, i) => {
    out.push(item);
    const following = byAnchor.get(getKey(item, i));
    if (following) out.push(...following);
  });
  return out;
}

function symmetricDifference(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const key of a) if (!b.has(key)) out.push(key);
  for (const key of b) if (!a.has(key)) out.push(key);
  return out;
}
