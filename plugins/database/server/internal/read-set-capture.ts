import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { Db } from "./driver";

// A loader's read-set contains ONLY the tables it READS — matched from the read
// clauses FROM / JOIN. Write targets (INSERT INTO / UPDATE / DELETE) are
// deliberately excluded: loaders are read-only by contract, so any write captured
// under a loader's ambient context is a foreign observability leak (e.g. the
// report path's `INSERT INTO "notifications"` running inside whatever loader
// happened to be open), never a genuine read dependency. Exported for co-located
// unit testing.
//
// HOW THE NAME IS SPELLED DOES NOT MATTER. Drizzle double-quotes every
// identifier it emits; a hand-written `sql` template usually does not, because
// that is how people write SQL. Both are matched, and they differ only in what
// happens after the match:
//
//   - a QUOTED name is taken as written, exactly as it always has been;
//   - an UNQUOTED name is only a candidate. Anything at all can follow FROM — a
//     CTE name, a subquery alias, a set-returning function — so a candidate is
//     kept only if it names a relation that really exists in the `public` schema
//     (`setKnownRelations` below). A phantom name in a read-set is not free
//     noise: the Debug → Read-set pane calls a resource a "silent FULL" the
//     moment its read-set holds a table the change-feed does not cover, so
//     unfiltered aliases would drown the one surface that exists to spot this
//     class of bug. While no relation set is installed — before boot loads it,
//     and on the central runtime, which never touches this pool — every unquoted
//     candidate is dropped, so capture is then byte-identical to the
//     quoted-only behaviour this replaces.
//
// Three guards on the unquoted branch, each with a live site in this repo:
//   - `IS DISTINCT FROM` is an operator, not a FROM clause, and what follows it
//     is an expression (`page-doc-order.ts` has one inside a live loader). It is
//     matched and then dropped, the same way `DELETE FROM`'s write target is —
//     matching it is what stops the bare `from` branch from picking its operand
//     up.
//   - a candidate immediately followed by `(` is a function call, not a relation
//     — `FROM unnest(…)` and `CROSS JOIN LATERAL (…)`, both in the chord
//     progress loader.
//   - a leading `ONLY` belongs to the clause, not to the name, so `FROM ONLY
//     tasks` captures `tasks`.
//
// A schema-qualified name keeps only its relation part when the schema is
// `public` (which is what the change-feed reports as `TG_TABLE_NAME`), and is
// dropped whole otherwise: the jobs list loader reads
// `FROM graphile_worker._private_jobs`, a schema the change-feed structurally
// excludes, so recording it would add a dependency that can never fire.
//
// One over-capture stays possible: a CTE named after a real table
// (`WITH tasks AS (…) SELECT … FROM tasks`) records a phantom dependency. That
// costs one extra recompute and never a missed one — the direction this index
// has always been allowed to err in.
export function extractReadTablesFromSql(text: string): string[] {
  const tables = new Set<string>();
  for (const name of readClauseNames(text)) {
    if (name.quoted) {
      tables.add(name.text);
      continue;
    }
    const relation = publicRelationName(name.text);
    if (relation !== null && knownRelations?.has(relation))
      tables.add(relation);
  }
  return Array.from(tables);
}

/**
 * The relations a read-set captures from `text` whatever relation set is
 * installed: every double-quoted name a read clause (FROM / JOIN) names,
 * deduped, in order of first appearance — exactly the quoted branch of
 * {@link extractReadTablesFromSql}, with no known-relations filter. Pure.
 *
 * What a compiler rendering raw SQL checks its text against: a quoted name is
 * taken as written, so a CTE or subquery alias spelled quoted would land in
 * every read-set the query is captured under (a phantom dependency the
 * Read-set pane reports as a silent FULL). A raw shape therefore spells its
 * own names unquoted, and the relations this returns for it must be exactly
 * the tables it routes.
 */
export function quotedRelationsIn(text: string): string[] {
  const out = new Set<string>();
  for (const name of readClauseNames(text)) {
    if (name.quoted) out.add(name.text);
  }
  return Array.from(out);
}

/**
 * Every name a read clause (FROM / JOIN) introduces in `text`, in order: a
 * double-quoted one as written, or an unquoted candidate (a function call —
 * a candidate followed by `(` — already dropped). `DELETE FROM`'s write target
 * and `IS DISTINCT FROM`'s operand are matched and dropped (see
 * {@link extractReadTablesFromSql}).
 */
function* readClauseNames(
  text: string,
): Generator<{ quoted: boolean; text: string }> {
  const re =
    /\b(distinct\s+from|delete\s+from|from|join)\s+(?:only\s+)?(?:"([^"]+)"|([a-z_][\w$.]*))(\s*\()?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const keyword = m[1]!.toLowerCase().replace(/\s+/g, " ");
    if (keyword !== "from" && keyword !== "join") continue; // write target / operator
    const quoted = m[2];
    if (quoted !== undefined) {
      yield { quoted: true, text: quoted };
      continue;
    }
    if (m[4] !== undefined) continue; // a call — `unnest(`, `lateral (`
    yield { quoted: false, text: m[3]! };
  }
}

// Postgres folds an unquoted identifier to lower case, so a candidate is
// normalised the same way before it is looked up. Returns null for a name
// qualified with a schema other than `public` — the change-feed reports changes
// under the bare relation name and covers `public` only.
function publicRelationName(candidate: string): string | null {
  const parts = candidate.toLowerCase().split(".");
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2 && parts[0] === "public") return parts[1]!;
  return null;
}

// The relations that really exist in `public`, as of the last load. `null` means
// none has been installed, which is the state of every process that never calls
// `loadKnownRelations` — and the reason an unquoted candidate is dropped rather
// than trusted there.
let knownRelations: ReadonlySet<string> | null = null;

// Exported for co-located unit testing: the filter is module-local state, so a
// test installs and clears its own set rather than reaching for a database.
export function setKnownRelations(relations: ReadonlySet<string> | null): void {
  knownRelations = relations;
}

const KnownRelationRowSchema = z.object({ relname: z.string() });

/**
 * Read which relations `public` really holds and install them for
 * {@link extractReadTablesFromSql}.
 *
 * Ordinary and partitioned tables plus plain and materialized views: loaders
 * read the derived views (`tasks_v`, `attempts_v`, …) as readily as base
 * tables, and the change-feed already expands a base-table change onto them.
 *
 * Idempotent, and it replaces the set wholesale — so it is safe to call again
 * after later DDL creates more relations (change-feed creates
 * `live_state_changelog` inside its own barrier hook).
 */
export async function loadKnownRelations(executor: Db): Promise<void> {
  const rows = await executeRows(executor, {
    query: drizzleSql.raw(
      `SELECT c.relname::text AS relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')`,
    ),
    row: KnownRelationRowSchema,
    label: "loadKnownRelations",
  });
  setKnownRelations(new Set(rows.map((r) => r.relname)));
}
