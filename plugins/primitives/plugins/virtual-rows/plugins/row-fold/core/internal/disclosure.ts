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
 * One change of a list, read: a TOGGLE (the open set flipped, and the rows
 * changed only as those flips would change them) with what it drew — `null`
 * when it drew nothing yet (a lazy node opening onto rows still on their way) —
 * or any other CHANGE, which lands as it is and awaits nothing.
 */
export type DisclosureRead<T> =
  { kind: "toggle"; disclosure: RowDisclosure<T> | null } | { kind: "change" };

const CHANGE = { kind: "change" } as const;

/**
 * Whether `prev → next` is a toggle, and what it revealed and hid.
 *
 * A change of the list is a toggle when a disclosure OPENED or CLOSED in
 * the same commit — a key whose membership in the open set flipped, and which
 * is not a row that itself appeared or vanished (a row inserted already
 * expanded, or deleted while expanded, is live data, not a toggle) — AND the
 * change has a disclosure's shape (`explainedByToggles`): the surviving rows
 * keep their order, each gap between two of them only gains rows or only
 * loses them, and — when every toggled key is a line both lists draw — no
 * more gaps change than lines toggled (a toggled line's subtree is one run).
 * A toggled key that is no line (a fold line's, a group's) may reveal rows in
 * any number of gaps: a fold line puts each folded row back in its place.
 *
 * The shape is what tells a toggle from a filter whose owner's open set
 * moves with it (a search holding every parent of a hit open, a filter
 * opening the nodes it keeps): a filter drops and adds rows all over the
 * list, between rows that stay. Every change that is not a toggle —
 * scrolling a window, a search, live inserts, a page arriving, and a toggle
 * that lands in the same commit as such a change — is a `change`, drawn as it
 * lands. A toggle that changed nothing drawn (a lazy node opening onto rows
 * still on their way, a toggle under a search holding the subtree open) is a
 * toggle with a `null` disclosure.
 *
 * `openKeys` lives in the owner's own key space — a tree's expanded node ids,
 * a table's open group or fold keys; only its flips are read, so the shape is
 * read from the rows alone, never from where a toggled key sits.
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
}): DisclosureRead<T> {
  const flipped = symmetricDifference(prevOpen, nextOpen);
  if (flipped.length === 0) return CHANGE;
  const prevKeys = prevItems.map(getKey);
  const nextKeys = nextItems.map(getKey);
  const prevSet = new Set(prevKeys);
  const nextSet = new Set(nextKeys);
  // Toggled: a flipped key drawn in both lists (a tree line), or drawn in
  // neither (a fold line's or a group's key, in the owner's own key space).
  const onLines = flipped.filter(
    (key) => prevSet.has(key) && nextSet.has(key),
  ).length;
  const offLines = flipped.some(
    (key) => !prevSet.has(key) && !nextSet.has(key),
  );
  if (onLines === 0 && !offLines) return CHANGE;
  // A toggled line reveals or hides one run, right under it; a key that is no
  // line may reveal rows anywhere (a fold line puts each folded row back in
  // its sorted place), so it bounds nothing.
  const maxRuns = offLines ? Infinity : onLines;
  if (!explainedByToggles(prevKeys, nextKeys, prevSet, nextSet, maxRuns))
    return CHANGE;

  const revealed = new Set(nextKeys.filter((key) => !prevSet.has(key)));
  const hidden: FoldingRow<T>[] = [];
  let after: string | null = null;
  prevKeys.forEach((key, i) => {
    if (nextSet.has(key)) after = key;
    else hidden.push({ key, item: prevItems[i]!, after });
  });
  return {
    kind: "toggle",
    disclosure:
      revealed.size === 0 && hidden.length === 0 ? null : { revealed, hidden },
  };
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

/**
 * Whether `prevKeys → nextKeys` is shaped like toggles and nothing else: the
 * rows both lists draw in the same order, each changed gap between them all
 * new rows (revealed) or all gone (hidden), and no more changed gaps than
 * `maxRuns` — one per toggled line (nested toggles inside one revealed
 * subtree share its run, so `<=`).
 */
function explainedByToggles(
  prevKeys: readonly string[],
  nextKeys: readonly string[],
  prevSet: ReadonlySet<string>,
  nextSet: ReadonlySet<string>,
  maxRuns: number,
): boolean {
  // Per gap (0 = before the first surviving row, i = after the i-th): what
  // the change did there — 1 removed rows, 2 inserted rows, 3 both.
  const gaps = new Map<number, number>();
  const survivors: string[] = [];
  for (const key of prevKeys) {
    if (nextSet.has(key)) survivors.push(key);
    else gaps.set(survivors.length, 1);
  }
  let seen = 0;
  for (const key of nextKeys) {
    if (prevSet.has(key)) {
      // A surviving row out of its old order: a sort, not a toggle.
      if (survivors[seen] !== key) return false;
      seen++;
    } else gaps.set(seen, (gaps.get(seen) ?? 0) | 2);
  }
  if (gaps.size > maxRuns) return false;
  for (const what of gaps.values()) if (what === 3) return false;
  return true;
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
