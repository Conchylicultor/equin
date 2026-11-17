import { useState } from "react";

/**
 * What one change of trail animates. Only a trail that grew deeper or went
 * back up animates: a change that is neither (another place altogether) is
 * drawn as it lands, since no crumb carries over to move from.
 */
export interface TrailChange<S extends { key: string }> {
  /** Keys of the crumbs the trail went into: wiped in. */
  entering: ReadonlySet<string>;
  /** The crumbs the trail came back out of, in order: still drawn, wiped out. */
  leaving: readonly S[];
  /** The old current crumb, now an ancestor: dims from the leaf's colour. */
  demoted: string | null;
  /** The ancestor that is the current crumb again: brightens. */
  promoted: string | null;
}

const NONE: TrailChange<never> = {
  entering: new Set(),
  leaving: [],
  demoted: null,
  promoted: null,
};

/** The change from `before` to `after`, read from their keys alone. */
export function trailChange<S extends { key: string }>(
  before: readonly S[],
  after: readonly S[],
): TrailChange<S> {
  const down =
    after.length > before.length &&
    before.every((s, i) => after[i]?.key === s.key);
  const up =
    before.length > after.length &&
    after.every((s, i) => before[i]?.key === s.key);
  if (down) {
    return {
      entering: new Set(after.slice(before.length).map((s) => s.key)),
      leaving: [],
      demoted: before.at(-1)?.key ?? null,
      promoted: null,
    };
  }
  if (up) {
    return {
      entering: new Set(),
      leaving: before.slice(after.length),
      demoted: null,
      promoted: after.at(-1)?.key ?? null,
    };
  }
  return NONE;
}

/**
 * The trail's last change, while it plays. Derived in render from the
 * segments the trail last drew (the state-from-props pattern), so the frame
 * that shows the new trail is the frame its animation starts on. `settle()`
 * ends it — called when the animation ends, it drops the leaving crumbs and
 * the classes that would replay on a remount. Off (`enabled` false), nothing
 * is tracked and the change is always none.
 */
export function useTrailMotion<S extends { key: string }>(
  segments: readonly S[],
  enabled: boolean,
): { change: TrailChange<S>; settle: () => void } {
  const [shown, setShown] = useState(segments);
  const [change, setChange] = useState<TrailChange<S>>(NONE);
  const keysOf = (list: readonly S[]) => list.map((s) => s.key).join("\u0000");
  if (enabled && keysOf(shown) !== keysOf(segments)) {
    setChange(trailChange(shown, segments));
    setShown(segments);
  }
  return {
    change: enabled ? change : NONE,
    settle: () => setChange(NONE),
  };
}
