import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { TableLayoutRequirement } from "@plugins/framework/plugins/server-core/core";

// A3 of research/2026-09-29-global-scoped-change-routing.md: every routed
// table's INSTALLED triggers — read back from the catalog, never assumed from
// the layout `rebuildTriggers` was handed — are the routed function with the
// layout its routes need:
//
//  - argument 0 is the table's single-column PK ('' for a composite one): the
//    `ids` the router maps an identity route through, and the key old and new
//    rows pair up by for `unchanged`;
//  - argument 1 carries every column a route maps through (`column`), filters
//    by (`rows`) or lets a tuple match on (`match`) — a column the trigger does
//    not carry reads `keys` as unknown and recomputes its readers FULL on every
//    change.
//
// Argument 2, the gate, is not checked: `unchanged` lists only columns it
// compared and found equal, so any gate is sound — a narrower one only skips
// less.
//
// Anything else blocks boot. (The layout is derived from the routes, so a miss
// means the installed triggers are not the ones the routes asked for — a
// skipped or failed rebuild, a trigger replaced out of band.)

/** One installed `live_state_*` trigger: its table, function and arguments, and the table's PK. */
export interface InstalledTrigger {
  table: string;
  trigger: string;
  fn: string;
  args: readonly string[];
  /** The table's single-column primary key, or '' (composite / none). */
  pk: string;
}

/** What one installed trigger emits: `null` = the PK-only function. */
export type InstalledTriggerLayout = {
  pk: string;
  carry: readonly string[];
} | null;

/** What one routed table's installed triggers emit, as the catalog says. */
export interface InstalledLayout {
  table: string;
  /** The table's single-column primary key, or '' (composite / none). */
  pk: string;
  /** Per trigger (i / u / d). */
  triggers: ReadonlyMap<string, InstalledTriggerLayout>;
}

// `tgargs` is a `bytea` of NUL-terminated arguments; `tgnargs` counts them.
// A `bytea` decodes to a `Uint8Array` on every driver (node-postgres's `Buffer`
// is one; PGlite returns a plain `Uint8Array`).
// `pk` is the table's primary key column when it has exactly one key column
// (a scalar `name`, decoded to a string), else NULL.
const TriggerArgsRowSchema = z.object({
  relname: z.string(),
  tgname: z.string(),
  proname: z.string(),
  tgnargs: z.number(),
  tgargs: z.instanceof(Uint8Array),
  pk: z.string().nullable(),
});

/** Decode `pg_trigger.tgargs` (NUL-terminated strings). */
export function decodeTriggerArgs(raw: Uint8Array, count: number): string[] {
  const parts = new TextDecoder().decode(raw).split("\u0000");
  // Each argument is NUL-terminated, so the split leaves one trailing "".
  const args = parts.slice(0, count);
  if (args.length !== count) {
    throw new Error(
      `[change-feed] trigger arguments decode to ${args.length} value(s), expected ${count}`,
    );
  }
  return args;
}

/** Every installed `live_state_*` trigger on the given tables. */
export async function readInstalledTriggers(
  db: NodePgDatabase,
  tables: readonly string[],
): Promise<InstalledTrigger[]> {
  if (tables.length === 0) return [];
  const rows = await executeRows(db, {
    query: drizzleSql`
      SELECT c.relname, t.tgname, p.proname, t.tgnargs::int AS tgnargs, t.tgargs,
             (SELECT a.attname
              FROM pg_index i
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
              WHERE i.indrelid = c.oid AND i.indisprimary AND i.indnkeyatts = 1) AS pk
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public'
        AND NOT t.tgisinternal
        AND t.tgname LIKE 'live_state_%'
        AND c.relname IN (${drizzleSql.join(
          tables.map((t) => drizzleSql`${t}`),
          drizzleSql`, `,
        )})`,
    row: TriggerArgsRowSchema,
    label: "readInstalledTriggers",
  });
  return rows.map((r) => ({
    table: r.relname,
    trigger: r.tgname,
    fn: r.proname,
    args: decodeTriggerArgs(r.tgargs, r.tgnargs),
    pk: r.pk ?? "",
  }));
}

// One JSON column-list argument of the routed function.
function columnList(t: InstalledTrigger, index: number): string[] {
  const raw = t.args[index];
  const parsed: unknown = raw === undefined ? undefined : JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((c): c is string => typeof c === "string")
  ) {
    throw new Error(
      `[change-feed] trigger "${t.trigger}" on "${t.table}" has an unreadable layout argument ${index}: ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/** What each table's installed triggers emit. */
export function installedLayouts(
  triggers: readonly InstalledTrigger[],
): Map<string, InstalledLayout> {
  const out = new Map<string, InstalledLayout>();
  for (const t of triggers) {
    let layout = out.get(t.table);
    if (!layout) {
      layout = { table: t.table, pk: t.pk, triggers: new Map() };
      out.set(t.table, layout);
    }
    (layout.triggers as Map<string, InstalledTriggerLayout>).set(
      t.trigger,
      t.fn === "live_state_notify_routed"
        ? {
            pk: t.args[0] ?? "",
            carry: columnList(t, 1),
          }
        : null,
    );
  }
  return out;
}

/** One way an installed trigger does not emit what its table's routes read. */
export type LayoutViolation = { table: string; trigger: string } & (
  | { kind: "unrouted" }
  | { kind: "pk"; installed: string; expected: string }
  | { kind: "carry"; missing: readonly string[] }
);

/**
 * The requirements the installed layouts do not meet: for each routed table,
 * each of its three triggers must be the routed function, keyed on the table's
 * PK, carrying every required column. A table with no installed trigger is
 * route-coverage's to report (A1), not this check's.
 */
export function findLayoutViolations(
  requirements: readonly TableLayoutRequirement[],
  installed: ReadonlyMap<string, InstalledLayout>,
): LayoutViolation[] {
  const out: LayoutViolation[] = [];
  for (const req of requirements) {
    const layout = installed.get(req.table);
    if (!layout) continue;
    for (const [trigger, emits] of [...layout.triggers].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const at = { table: req.table, trigger };
      // The PK-only function on a routed table misses its old ∪ new ids and
      // `unchanged` even when nothing is carried.
      if (emits === null) {
        out.push({ ...at, kind: "unrouted" });
        continue;
      }
      if (emits.pk !== layout.pk) {
        out.push({
          ...at,
          kind: "pk",
          installed: emits.pk,
          expected: layout.pk,
        });
      }
      const carryMissing = req.carry.filter((c) => !emits.carry.includes(c));
      if (carryMissing.length > 0) {
        out.push({ ...at, kind: "carry", missing: carryMissing });
      }
    }
  }
  return out;
}

const quoted = (cols: readonly string[]): string =>
  cols.map((c) => `"${c}"`).join(", ");

function describeViolation(v: LayoutViolation): string {
  switch (v.kind) {
    case "unrouted":
      return "calls the PK-only function, not the routed one";
    case "pk":
      return `is keyed on "${v.installed}", not the table's primary key "${v.expected}"`;
    case "carry":
      return `does not carry ${quoted(v.missing)}`;
  }
}

/** The boot error for violations, naming each table, trigger and what it misses. */
export function formatLayoutViolations(
  violations: readonly LayoutViolation[],
): string {
  return (
    `[change-feed] ${violations.length} routed trigger layout violation(s) — the installed triggers do not emit what their routes read (A3):\n` +
    violations
      .map((v) => `  - "${v.table}" (${v.trigger}) ${describeViolation(v)}`)
      .join("\n") +
    "\nThe installed triggers are not the ones the routes derive — a rebuild that did not run or a trigger replaced out of band. Restart to rebuild the feed; if it persists, the trigger compiler dropped a layout."
  );
}

/** A3: throw (block boot) unless every routed table's installed triggers emit what its routes read. */
export async function assertRouteLayoutsInstalled(
  db: NodePgDatabase,
  requirements: readonly TableLayoutRequirement[],
): Promise<void> {
  const triggers = await readInstalledTriggers(
    db,
    requirements.map((r) => r.table),
  );
  const violations = findLayoutViolations(
    requirements,
    installedLayouts(triggers),
  );
  if (violations.length > 0) {
    throw new Error(formatLayoutViolations(violations));
  }
}
