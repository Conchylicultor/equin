import { join } from "path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  grepCode,
  type CodeMatch,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import * as derivedViewsCore from "@plugins/database/plugins/derived-views/core";
import { IMPERATIVE_PUBLIC_TABLES } from "@plugins/database/plugins/derived-views/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

// The allowlist source of truth. What this check needs is the IDENTIFIER NAMES,
// not the table names — the create sites interpolate the constant and the
// convention enforced here is that the identifier appears on the CREATE line.
// Those names are the KEYS of the shorthand `IMPERATIVE_PUBLIC_TABLES` record,
// published as data; this check used to regex them out of that module's TEXT.
// The path below is now MESSAGE-ONLY — it points a human at the file to edit; no
// code reads it.
const ALLOWLIST_SRC_REL =
  "plugins/database/plugins/derived-views/core/internal/imperative-tables.ts";

// This check's OWN source (its description/message/hint strings spell out the
// token) is exempted in the migrations plugin's `exempt/index.ts` — a
// self-reference hatch, not a general opt-out.
//
// The check otherwise scans the whole repo, because an imperative table can be
// created from anywhere that boots against a worktree DB. The one other exemption
// is derived from evidence rather than listed: a CREATE TABLE aimed at a
// throwaway test database (see `usesThrowawayTestDb` below).

// A CREATE TABLE in a test that provisions its own THROWAWAY database is not
// worktree schema, and exempting it is a scope correction rather than a hole.
//
// The rule this check enforces exists for exactly one downstream reason (see the
// hint): an imperative public table that is not allowlisted gets flagged later by
// `orphaned-db-tables` as dead schema. That check only ever scans the LIVE
// WORKTREE DB. `createTestDb` mints a randomly-named database on the cluster and
// drops it in teardown, so a table created through that fixture never enters the
// worktree DB and cannot reach `orphaned-db-tables` at all — the failure mode the
// allowlist prevents does not exist for it. Demanding an allowlist entry anyway
// would be a false positive AND actively harmful: it would push per-suite
// fixtures into the production allowlist, where `orphaned-db-tables` would then
// treat a name that exists in no real database as declared schema.
//
// BOTH conditions are required, which is what keeps this narrow: the file must be
// a test file AND must import the fixture barrel that hands out throwaway
// databases. A `*.test.ts` that reaches the real `db` — the only way a test could
// create a table that actually persists — imports `@plugins/database/server`, not
// this barrel, so it stays fully covered by the rule.
//
// The other throwaway database is an IN-MEMORY PGlite the test opens itself
// (`createPgliteDriver()` / `new PGlite()` with no data dir): Postgres compiled
// to WASM inside the test process, gone with it, and never the cluster the
// worktree DB lives on — so `orphaned-db-tables` cannot see its tables either.
// Only the argument-less call counts: a data dir is storage that outlives the
// test.
const TEST_FILE_RE = /\.test\.tsx?$/;
const TEST_DB_FIXTURE_IMPORT_RE =
  /from\s+["']@plugins\/database\/plugins\/db-test-fixture\/server\/testing["']/;
const IN_MEMORY_PGLITE_RE = /\b(?:createPgliteDriver|new\s+PGlite)\s*\(\s*\)/;

/**
 * PURE helper (exported for unit testing): does this file create its tables in a
 * throwaway database — one provisioned by the db-test-fixture primitive, or an
 * in-memory PGlite it opens itself? Takes the file's own source so the decision
 * is evidence-based (a real import or call), never a path convention alone.
 */
export function usesThrowawayTestDb(path: string, src: string): boolean {
  return (
    TEST_FILE_RE.test(path) &&
    (TEST_DB_FIXTURE_IMPORT_RE.test(src) || IN_MEMORY_PGLITE_RE.test(src))
  );
}

// A CREATE TABLE line that GENERATES its table name from data (derived-tables'
// `defineRollup` renders a rollup's table from its drizzle read handle) cannot
// spell the name's constant — the line holds an expression, not an identifier.
// It is coupled to the allowlist by EVIDENCE instead: the line itself calls
// `assertImperativePublicTable(…)` (derived-views/core), which throws unless the
// name is an IMPERATIVE_PUBLIC_TABLES value. The token is read off the barrel
// below, so a rename of that function cannot leave this exemption dangling.
//
// Line-level on purpose, like the constant rule: another CREATE TABLE in the
// same file that neither names a constant nor calls the assert is still an
// offender.
export const RUNTIME_ASSERT_FN = "assertImperativePublicTable";

/**
 * PURE helper (exported for unit testing): does this CREATE TABLE line carry the
 * runtime allowlist assert (`assertImperativePublicTable(`) in place of a
 * constant?
 */
export function callsRuntimeAssert(lineText: string): boolean {
  return new RegExp(`\\b${RUNTIME_ASSERT_FN}\\s*\\(`).test(lineText);
}

// Matches `CREATE TABLE` and `CREATE UNLOGGED TABLE` (unlogged tables persist in
// pg_stat_user_tables, so they are orphan-able and must be allowlisted too).
// TEMP/TEMPORARY are deliberately NOT matched: they are session-scoped and never
// become persistent orphans (none exist in the codebase today).
const CREATE_TABLE_RE = /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\b/i;

/**
 * PURE helper (exported for unit testing): the allowlist's identifier names —
 * the KEYS of the `IMPERATIVE_PUBLIC_TABLES` record — after PROVING the shorthand
 * invariant every consumer of those keys depends on: each key must name an export
 * of the `derived-views/core` barrel holding that exact table name.
 *
 * The barrel is the right comparison target, not a convenience: every create site
 * and `pgTable` read handle imports its constant from
 * `@plugins/database/plugins/derived-views/core`, so "the key names a barrel
 * export with this value" IS the coupling this check matches textually. A
 * non-shorthand entry (`{ ALIAS: MY_TABLE }`) or a constant missing from the
 * barrel breaks it — and would otherwise surface as a confusing false positive at
 * a legitimate CREATE TABLE line rather than here, at the declaration.
 *
 * Throws rather than returning a partial set (matching the previous parser's
 * fail-loud contract): a broken or empty allowlist would make the rule vacuous —
 * every CREATE TABLE an offender for the wrong reason — which is an error, not a
 * clean state. Mirrors declaredTablesFromSnapshot's empty-set guard.
 */
export function allowlistIdentifiers(
  mapping: Record<string, string>,
  barrelExports: Record<string, unknown>,
): Set<string> {
  const ids = Object.keys(mapping);
  if (ids.length === 0) {
    throw new Error(
      `IMPERATIVE_PUBLIC_TABLES is empty in ${ALLOWLIST_SRC_REL} — refusing to enforce a vacuous allowlist`,
    );
  }
  const broken = ids.filter((id) => barrelExports[id] !== mapping[id]);
  if (broken.length > 0) {
    throw new Error(
      `IMPERATIVE_PUBLIC_TABLES key(s) [${broken.join(", ")}] in ${ALLOWLIST_SRC_REL} do not name an ` +
        `export of @plugins/database/plugins/derived-views/core holding that table name. Each entry must ` +
        `be written SHORTHAND (\`{ MY_TABLE }\`, never \`{ ALIAS: MY_TABLE }\`) and its constant must be ` +
        `re-exported from that barrel — the create sites import it from there, and the key is the ` +
        `identifier this check requires on the CREATE TABLE line.`,
    );
  }
  return new Set(ids);
}

/**
 * PURE helper (exported for unit testing): an offender is a real-code
 * CREATE TABLE match whose line does NOT name any allowlist identifier, and which
 * is not in a file that creates it in a throwaway test database (`exemptPaths`,
 * resolved by the caller — see `usesThrowawayTestDb`) and is not `skips`ped (the
 * declared exemptions). `skips` is consulted last, only for a real offender, so
 * the runner can tell which declared exemptions went unused. Returns
 * "path:line:text" strings.
 */
export function findOffenders(
  matches: CodeMatch[],
  allowlistIds: Set<string>,
  exemptPaths: ReadonlySet<string> = new Set(),
  skips: (path: string) => boolean = () => false,
): string[] {
  const ids = [...allowlistIds];
  return matches
    .filter((m) => !exemptPaths.has(m.path))
    .filter((m) => !callsRuntimeAssert(m.text))
    .filter((m) => !ids.some((id) => new RegExp(`\\b${id}\\b`).test(m.text)))
    .filter((m) => !skips(m.path))
    .map((m) => `${m.path}:${m.line}:${m.text.trim()}`);
}

const check: Check = {
  id: "imperative-create-table-allowlisted",
  description:
    "every imperative CREATE TABLE references an IMPERATIVE_PUBLIC_TABLES constant, so a public table created outside drizzle cannot land unallowlisted (the static gate complementing the DB-side orphaned-db-tables check)",
  // Pure source scan, but cheap (one git grep narrows to a handful of files).
  // Never cache: a stale PASS on a correctness gate is worse than re-scanning.
  cacheSignature: () => null,
  exemptable: {
    "imperative-create-table-allowlisted":
      "spells an imperative CREATE TABLE without naming an IMPERATIVE_PUBLIC_TABLES constant (only a file that names the token to ban it may)",
  },
  async run(ctx) {
    const root = await getWorktreeRoot();
    const exempt = await ctx.exempt("imperative-create-table-allowlisted");
    const allowlistIds = allowlistIdentifiers(
      IMPERATIVE_PUBLIC_TABLES,
      derivedViewsCore,
    );
    // The runtime-assert evidence names a barrel function; prove it is there.
    if (
      typeof (derivedViewsCore as Record<string, unknown>)[
        RUNTIME_ASSERT_FN
      ] !== "function"
    ) {
      throw new Error(
        `${RUNTIME_ASSERT_FN} is not a function export of @plugins/database/plugins/derived-views/core — the runtime-assert exemption of this check names it.`,
      );
    }

    // maskStrings:false is load-bearing: the DDL lives INSIDE a template string,
    // so we must keep string interiors visible to see `CREATE TABLE` and the
    // `${CONST}` identifier. Comments are masked regardless, so the comment-only
    // mentions (rank/core types, data-migration-dml-only) are excluded.
    const matches = await grepCode({
      root,
      pattern: CREATE_TABLE_RE,
      grepArg: "CREATE",
      maskStrings: false,
    });

    // Resolve the throwaway-test-db exemption from each candidate's SOURCE (an
    // actual fixture import), not from its path. Only test files among the
    // matches are read, so this stays a handful of small reads on top of the grep.
    const exemptPaths = new Set<string>();
    for (const path of new Set(matches.map((m) => m.path))) {
      if (!TEST_FILE_RE.test(path)) continue;
      if (usesThrowawayTestDb(path, await Bun.file(join(root, path)).text())) {
        exemptPaths.add(path);
      }
    }

    const offenders = findOffenders(
      matches,
      allowlistIds,
      exemptPaths,
      exempt.skips,
    );
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `imperative CREATE TABLE not coupled to the allowlist in ${offenders.length} place(s):\n` +
        offenders.map((o) => `  - ${o}`).join("\n"),
      hint:
        `An imperatively-created public table (CREATE TABLE outside drizzle's tracked schema) must be ` +
        `registered in IMPERATIVE_PUBLIC_TABLES (${ALLOWLIST_SRC_REL}) or the orphaned-db-tables check ` +
        `will flag it as dead schema on a later build. Add a name constant there, add it to the ` +
        `IMPERATIVE_PUBLIC_TABLES record BY SHORTHAND, and interpolate that constant by its canonical name on the ` +
        `CREATE TABLE line (e.g. \`CREATE TABLE IF NOT EXISTS \${MY_TABLE} (…)\`). To create a tracked, ` +
        `drizzle-managed table instead, define it in the plugin's tables.ts and run ./singularity build. ` +
        `In a TEST that only needs a scratch table, provision a throwaway database with createTestDb ` +
        `(@plugins/database/plugins/db-test-fixture/server/testing) and create the table on it — that never ` +
        `touches the worktree DB, so it is exempt and must NOT be added to the allowlist.`,
    };
  },
};

export default check;
