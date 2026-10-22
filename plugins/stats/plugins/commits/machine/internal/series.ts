import type { CommitBucket, CommitSeries } from "../../shared/values";
import type { CommitInfo } from "./commit-log";

// The pure half of every commits value: commits in, series points out. A
// cumulative series is one point per day holding a commit (the committer's own
// calendar day, `iso.slice(0, 10)`), each carrying the running total; a rate
// series one point per UTC bucket holding a commit, each carrying that bucket's
// own total. Points are sorted by `x`.

type LinesDelta = { added: number; removed: number };

function bucketKey(iso: string, bucket: CommitBucket): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  switch (bucket) {
    case "hour":
      return `${y}-${m}-${day} ${hour}:00`;
    case "day":
      return `${y}-${m}-${day}`;
    case "week": {
      const monday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
      const dow = monday.getUTCDay() || 7;
      monday.setUTCDate(monday.getUTCDate() - (dow - 1));
      const wy = monday.getUTCFullYear();
      const wm = String(monday.getUTCMonth() + 1).padStart(2, "0");
      const wd = String(monday.getUTCDate()).padStart(2, "0");
      return `${wy}-${wm}-${wd}`;
    }
    case "month":
      return `${y}-${m}`;
    case "year":
      return `${y}`;
  }
}

function keyFor(series: CommitSeries): (c: CommitInfo) => string {
  switch (series.kind) {
    case "cumulative":
      return (c) => c.iso.slice(0, 10);
    case "rate":
      return (c) => bucketKey(c.iso, series.bucket);
  }
}

/**
 * Folds each commit into its point's accumulator, then emits the points in `x`
 * order — for a cumulative series, after folding every earlier point's
 * accumulator into a running one (`accumulate`).
 */
function seriesPoints<A, P>(
  commits: readonly CommitInfo[],
  series: CommitSeries,
  fold: {
    empty: () => A;
    add: (acc: A, c: CommitInfo) => void;
    merge: (into: A, from: A) => void;
    point: (x: string, acc: A) => P;
  },
): P[] {
  const key = keyFor(series);
  const perKey = new Map<string, A>();
  for (const c of commits) {
    const k = key(c);
    let acc = perKey.get(k);
    if (acc === undefined) {
      acc = fold.empty();
      perKey.set(k, acc);
    }
    fold.add(acc, c);
  }
  const keys = [...perKey.keys()].sort();
  if (series.kind === "rate")
    return keys.map((x) => fold.point(x, perKey.get(x)!));
  const running = fold.empty();
  return keys.map((x) => {
    fold.merge(running, perKey.get(x)!);
    return fold.point(x, running);
  });
}

function addDelta(
  into: Record<string, LinesDelta>,
  ext: string,
  d: LinesDelta,
) {
  const e = into[ext] ?? { added: 0, removed: 0 };
  e.added += d.added;
  e.removed += d.removed;
  into[ext] = e;
}

export function countPoints(
  commits: readonly CommitInfo[],
  series: CommitSeries,
): { x: string; count: number }[] {
  return seriesPoints(commits, series, {
    empty: () => ({ n: 0 }),
    add: (acc) => {
      acc.n += 1;
    },
    merge: (into, from) => {
      into.n += from.n;
    },
    point: (x, acc) => ({ x, count: acc.n }),
  });
}

export function countByItemPoints(
  commits: readonly CommitInfo[],
  series: CommitSeries,
  itemOf: (c: CommitInfo) => string,
): { x: string; byItem: Record<string, number> }[] {
  return seriesPoints<
    Record<string, number>,
    { x: string; byItem: Record<string, number> }
  >(commits, series, {
    empty: () => ({}),
    add: (acc, c) => {
      const item = itemOf(c);
      acc[item] = (acc[item] ?? 0) + 1;
    },
    merge: (into, from) => {
      for (const [item, n] of Object.entries(from))
        into[item] = (into[item] ?? 0) + n;
    },
    point: (x, acc) => ({ x, byItem: { ...acc } }),
  });
}

export function linesPoints(
  commits: readonly CommitInfo[],
  series: CommitSeries,
): { x: string; added: number; removed: number }[] {
  return seriesPoints<
    LinesDelta,
    { x: string; added: number; removed: number }
  >(commits, series, {
    empty: () => ({ added: 0, removed: 0 }),
    add: (acc, c) => {
      acc.added += c.added;
      acc.removed += c.removed;
    },
    merge: (into, from) => {
      into.added += from.added;
      into.removed += from.removed;
    },
    point: (x, acc) => ({ x, added: acc.added, removed: acc.removed }),
  });
}

export function linesByExtPoints(
  commits: readonly CommitInfo[],
  series: CommitSeries,
): { x: string; byExt: Record<string, LinesDelta> }[] {
  return seriesPoints<
    Record<string, LinesDelta>,
    { x: string; byExt: Record<string, LinesDelta> }
  >(commits, series, {
    empty: () => ({}),
    add: (acc, c) => {
      for (const [ext, d] of Object.entries(c.byExt)) addDelta(acc, ext, d);
    },
    merge: (into, from) => {
      for (const [ext, d] of Object.entries(from)) addDelta(into, ext, d);
    },
    point: (x, acc) => ({
      x,
      byExt: Object.fromEntries(
        Object.entries(acc).map(([ext, d]) => [ext, { ...d }]),
      ),
    }),
  });
}
