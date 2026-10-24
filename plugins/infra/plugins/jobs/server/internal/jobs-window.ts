import type {
  LiveCutKey,
  LiveDecodedCountQuery,
  LiveDecodedGroupQuery,
  LiveDecodedQuery,
  LiveGroup,
  LiveKeyDirection,
} from "@plugins/network/plugins/live/core";
import {
  compareScalars,
  matchesFilter,
  type FilterScalar,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { jobRunAtKeyText, jobs, type JobRow } from "../../core/resources";

// The questions the `jobs` collection asks a queue (`JobQueue`'s `window` /
// `rows` / `groups` / `count`), and their one in-memory answer over a list of
// rows: what the in-process queue serves, and the oracle a SQL queue's answers
// are held to (`machine/internal/jobs-list.test.ts`).

/** The window `jobs` asks for: its rows matching `where`, in `orderBy` (the id breaking ties), inside `(after, until]`, at most `limit`. */
export type JobsWindowQuery = LiveDecodedQuery<(typeof jobs.sortable)[number]>;
/** A grouping of the queue's rows by one filterable field. */
export type JobsGroupQuery = LiveDecodedGroupQuery<
  keyof typeof jobs.filterable & string
>;
export type JobsCountQuery = LiveDecodedCountQuery;

/**
 * The direction of a window's one order — `runAt`, the queue's only sort
 * (its keyset is `(runAt, id)`). Anything else is a decode the collection's
 * own codec would have refused, so it throws.
 */
export function jobsOrderOf(q: JobsWindowQuery): LiveKeyDirection {
  const [first, ...rest] = q.orderBy;
  if (first === undefined || first[0] !== "runAt" || rest.length > 0) {
    throw new Error(
      `jobs: the window is ordered by \`runAt\` alone — got ${JSON.stringify(q.orderBy)}`,
    );
  }
  return first[1];
}

/** A row's `$key` parts: its `runAt` text, then its id. */
export function jobKeyOf(row: Pick<JobRow, "runAt" | "id">): LiveCutKey {
  return [jobRunAtKeyText(row.runAt), row.id];
}

/**
 * `a` vs `b` (each `[runAtText, id]`) in the window's order: the instant in
 * `dir`, a NULL last either way, then the id ascending — both by code point
 * (the `$key` order every window is checked against).
 */
export function compareJobKeys(
  a: LiveCutKey,
  b: LiveCutKey,
  dir: LiveKeyDirection,
): number {
  const dirs = [dir, "asc"] as const;
  for (let i = 0; i < 2; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = compareScalars(x, y);
    if (c !== 0) return dirs[i] === "desc" ? -c : c;
  }
  return 0;
}

/** The in-memory answers over `all` — every row the queue lists. */
export function answerJobsInMemory(all: readonly JobRow[]) {
  const matching = (where: JobsCountQuery["where"]) =>
    all.filter((row) => matchesFilter(row, where, jobs.filterable));
  return {
    window(q: JobsWindowQuery): JobRow[] {
      const dir = jobsOrderOf(q);
      return matching(q.where)
        .filter((row) => {
          const key = jobKeyOf(row);
          if (q.after !== undefined && compareJobKeys(key, q.after, dir) <= 0) {
            return false;
          }
          return !(
            q.until !== undefined && compareJobKeys(key, q.until, dir) > 0
          );
        })
        .sort((a, b) => compareJobKeys(jobKeyOf(a), jobKeyOf(b), dir))
        .slice(0, q.limit);
    },
    rows(ids: readonly string[]): JobRow[] {
      const asked = new Set(ids);
      return all.filter((row) => asked.has(row.id));
    },
    groups(q: JobsGroupQuery): LiveGroup<FilterScalar>[] {
      const counts = new Map<FilterScalar | null, number>();
      for (const row of matching(q.where)) {
        const value = row[q.groupBy] as FilterScalar | null;
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      // Count descending, then the value (NULL last) — a table's grouping order.
      return [...counts]
        .map(([value, count]) => ({ value, count }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            (a.value === null
              ? b.value === null
                ? 0
                : 1
              : b.value === null
                ? -1
                : compareScalars(a.value, b.value)),
        )
        .slice(0, q.limit);
    },
    count(q: JobsCountQuery): number {
      return matching(q.where).length;
    },
  };
}
