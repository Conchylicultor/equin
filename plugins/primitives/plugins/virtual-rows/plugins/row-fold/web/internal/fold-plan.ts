/** Where a row is drawn at one end of the fold, relative to where it is laid out. */
export interface RowFrame {
  /** Vertical offset, px. */
  y: number;
  /** Bottom clip inset, px (negative clips nothing). Folding rows only. */
  clip?: number;
  /** Folding rows only. */
  opacity?: number;
}

export interface RowMotion {
  el: HTMLElement;
  from: RowFrame;
  to: RowFrame;
}

type Kind = "reveal" | "hide" | "stay";

/**
 * The fold's motion, read from the rows as they are laid out NOW — the
 * revealed rows in their place, the hidden ones still in theirs.
 *
 * Each run of consecutive revealed (or hidden) rows is ONE box growing from
 * nothing to its full height (or shrinking to nothing), the way a nested
 * `FoldMotion` box would: its rows stand still inside it and are uncovered
 * top-down, a bottom clip on each row standing in for the box's edge. Every
 * row moves with the runs above it: it starts where the old layout had it (up
 * by the revealed runs above) and ends where the new one does (up by the
 * hidden runs above). Offsets and clips are all linear in the tween's
 * progress, so one easing on every row keeps them in step.
 *
 * Rows are the host's direct children carrying `data-row-fold` (their key);
 * other children (a windowed body's spacers) are skipped. A row's share of a
 * run is its height plus the host's `row-gap` (a flex column's gap) — never
 * the distance to the next row, which a pinned sticky header misreports. Rows
 * whose path never crosses the viewport are left alone.
 */
export function planRowFold(
  host: HTMLElement,
  revealed: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  viewportHeight: number,
): RowMotion[] {
  const gap = parseFloat(getComputedStyle(host).rowGap) || 0;
  const rows: { el: HTMLElement; kind: Kind; top: number; height: number }[] =
    [];
  for (const child of host.children) {
    if (!(child instanceof HTMLElement)) continue;
    const key = child.dataset.rowFold;
    if (key === undefined) continue;
    const rect = child.getBoundingClientRect();
    rows.push({
      el: child,
      kind: revealed.has(key) ? "reveal" : hidden.has(key) ? "hide" : "stay",
      top: rect.top,
      height: rect.height + gap,
    });
  }

  const out: RowMotion[] = [];
  const push = (row: (typeof rows)[number], from: RowFrame, to: RowFrame) => {
    const lo = row.top + Math.min(from.y, to.y);
    const hi = row.top + row.height + Math.max(from.y, to.y);
    if (hi < 0 || lo > viewportHeight) return;
    out.push({ el: row.el, from, to });
  };
  // Heights of the revealed / hidden runs above the current row.
  let revealedAbove = 0;
  let hiddenAbove = 0;
  let i = 0;
  while (i < rows.length) {
    const kind = rows[i]!.kind;
    if (kind === "stay") {
      if (revealedAbove !== hiddenAbove)
        push(rows[i]!, { y: -revealedAbove }, { y: -hiddenAbove });
      i++;
      continue;
    }
    let end = i;
    let run = 0;
    while (end < rows.length && rows[end]!.kind === kind) {
      run += rows[end]!.height;
      end++;
    }
    let offset = 0;
    for (let k = i; k < end; k++) {
      const row = rows[k]!;
      // How far the row's bottom sits below the run's top: clipped by that
      // much the row is gone, by that much less the run's height it is whole.
      const bottom = offset + row.height;
      const shut = { clip: bottom, opacity: 0 };
      const open = { clip: bottom - run, opacity: 1 };
      push(
        row,
        { y: -revealedAbove, ...(kind === "reveal" ? shut : open) },
        { y: -hiddenAbove, ...(kind === "reveal" ? open : shut) },
      );
      offset = bottom;
    }
    if (kind === "reveal") revealedAbove += run;
    else hiddenAbove += run;
    i = end;
  }
  return out;
}

/** One end of a row's motion as a Web Animations keyframe. */
export function rowKeyframe(frame: RowFrame): Keyframe {
  return {
    transform: `translateY(${frame.y}px)`,
    ...(frame.clip !== undefined && {
      clipPath: `inset(0px 0px ${frame.clip}px 0px)`,
    }),
    ...(frame.opacity !== undefined && { opacity: frame.opacity }),
  };
}
