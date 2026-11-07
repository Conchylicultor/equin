import { recordKey } from "./keys";
import { relOwner } from "./rel-path";
import type { RecordStore, RecordTable } from "./store";

/**
 * Read records a GROUP at a time: the values of every member key of `groups`
 * that the store holds, as `getMany` over their union would answer them.
 *
 * A group (say one plugin's facet records, or the file records of one
 * plugin's files) is itself stored as one record: the values of all its
 * members, under a key made of the member keys alone. Each member key is the
 * full identity of its value, so the group's value is a pure function of its
 * key like any record's — never stale, never invalidated: a member that
 * changes is a new member key, so a new group key. A no-change build then
 * asks the store one key per group instead of one per member (a lookup is two
 * random B-tree probes of a ~1 GB file, ~20 µs; a build asked ~83k of them,
 * 0.43 s — build pipeline step 13), and a change costs the groups holding a
 * changed member, never the whole set.
 *
 * A group missing its record is answered member by member, and its record is
 * written once every member was found — so the read after the one that
 * computed a missing member hits. Callers choose groups that recur from build
 * to build (by plugin), or every read is a miss plus the member reads. A
 * group of one member is read as that member: its record would be the same
 * lookup, stored twice.
 *
 * A group hit reads no member row, so a member's last-read day is not
 * refreshed: a plugin unchanged for longer than the store keeps unread rows
 * (7 days) loses its member rows and keeps its group row. Its next change
 * misses the group (a member key moved) and recomputes the members that were
 * reclaimed — that plugin's records, never more: the cost of a change stays
 * the plugin it touches.
 */
export function readGrouped(
  store: RecordStore,
  table: RecordTable,
  groups: ReadonlyArray<readonly string[]>,
): Map<string, string> {
  const out = new Map<string, string>();
  const all = groups.map((g) => [...new Set(g)].sort());
  const singles = all.filter((g) => g.length === 1).map((g) => g[0]!);
  const members = all.filter((g) => g.length > 1);
  if (singles.length > 0)
    for (const [k, v] of store.getMany(table, singles)) out.set(k, v);
  const keyOf = (g: readonly string[]): string =>
    recordKey("group", table, ...g);
  const keys = members.map(keyOf);
  const stored = store.getMany("group", keys);
  const missed: string[][] = [];
  members.forEach((g, i) => {
    const text = stored.get(keys[i]!);
    if (text === undefined) {
      missed.push(g);
      return;
    }
    const values = JSON.parse(text) as string[];
    if (values.length !== g.length)
      throw new Error(
        `[plugin-records] group record ${keys[i]} holds ${values.length} values for ${g.length} members`,
      );
    g.forEach((k, j) => out.set(k, values[j]!));
  });
  if (missed.length === 0) return out;
  const found = store.getMany(table, missed.flat());
  const complete: [string, string][] = [];
  for (const g of missed) {
    let all = true;
    for (const k of g) {
      const v = found.get(k);
      if (v === undefined) all = false;
      else out.set(k, v);
    }
    if (all)
      complete.push([keyOf(g), JSON.stringify(g.map((k) => found.get(k)!))]);
  }
  if (complete.length > 0) store.putMany("group", complete);
  return out;
}

/**
 * `keys` (one per repo path of `paths`, in order) grouped by the plugin owning
 * each path ({@link relOwner}): the groups a per-file read hands
 * {@link readGrouped}.
 */
export function groupedByOwner(
  paths: readonly string[],
  keys: readonly string[],
): string[][] {
  const groups = new Map<string, string[]>();
  paths.forEach((rel, i) => {
    const owner = relOwner(rel);
    let g = groups.get(owner);
    if (!g) groups.set(owner, (g = []));
    g.push(keys[i]!);
  });
  return [...groups.values()];
}
