import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
// The imperative-public-table allowlist lives in the derived-views core leaf
// (the shared sink) — see that module for why it is NOT in @plugins/database/core.
import {
  IMPERATIVE_PUBLIC_TABLE_NAMES,
  MIGRATIONS_TABLE_NAME,
} from "@plugins/database/plugins/derived-views/core";
import { SCHEMA_SNAPSHOT_FILE } from "@plugins/database/plugins/migrations/core";
import { queryRows } from "@plugins/database/plugins/sql-rows/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { z } from "zod";
import { withDirectDb } from "./internal/direct-db";

// Inlined minimal Check shape (mirrors the sibling migration-applies-clean check)
// to avoid a cross-plugin import of the framework Check type from a check file.
type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type CheckContext = {
  log?: (line: string, stream: "stdout" | "stderr") => void;
};
type Check = {
  id: string;
  description: string;
  run(ctx: CheckContext): Promise<CheckResult>;
  cacheSignature?(): string | null;
};

// The migration SQL dir and the drizzle snapshot meta dir, relative to THIS check
// file (.../migrations/check/ → .../migrations/data{,/meta}).
const DATA_DIR = join(import.meta.dir, "..", "data");
const META_DIR = join(DATA_DIR, "meta");

// Filename → sha8 regex, inlined from the runner (server/internal/runner.ts) so
// this check never imports a server-plugin internal — mirroring the sibling
// fork-schema-drift check, which inlines the same pattern for the same reason.
const MIGRATION_RE = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;

// PURE helper (exported for unit testing): given a parsed drizzle snapshot
// object, return the set of declared public base-table names. The snapshot's
// `tables` is keyed "public.<name>"; each value carries a bare `name`. Throws if
// `tables` is missing/empty — an empty declared set would flag every live table
// as orphaned, which is a snapshot-read error, not a clean pass.
export function declaredTablesFromSnapshot(parsed: unknown): Set<string> {
  const tables = (parsed as { tables?: Record<string, { name?: string }> })
    .tables;
  if (!tables || typeof tables !== "object") {
    throw new Error("snapshot has no `tables` object");
  }
  const names = Object.values(tables)
    .map((t) => t.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  if (names.length === 0) {
    throw new Error(
      "snapshot `tables` is empty — refusing to treat every live table as orphaned",
    );
  }
  return new Set(names);
}

// PURE helper (exported for unit testing): orphans = live − declared − allowlist,
// sorted for stable output.
export function computeOrphans(
  live: string[],
  declared: Set<string>,
  allowlist: readonly string[],
): string[] {
  const allow = new Set(allowlist);
  return live
    .filter((t) => !declared.has(t) && !allow.has(t))
    .sort((a, b) => a.localeCompare(b));
}

// PURE helper (exported for unit testing): the migration files on disk whose
// sha8 is absent from the live DB's applied-migration ledger — i.e. the schema
// delta the DB has NOT caught up to yet. Non-migration filenames are ignored.
export function pendingMigrationFiles(
  files: readonly string[],
  appliedHashes: ReadonlySet<string>,
): string[] {
  return files
    .filter((f) => {
      const sha8 = MIGRATION_RE.exec(f)?.[3];
      return sha8 !== undefined && !appliedHashes.has(sha8);
    })
    .sort((a, b) => a.localeCompare(b));
}

// Read the head drizzle snapshot (meta/schema.snapshot.json, the snapshot
// DAG's tip — snapshot-chain-intact pins it) and parse out the declared
// table-name set.
function loadDeclaredTables(): Set<string> {
  const parsed = JSON.parse(
    readFileSync(join(META_DIR, SCHEMA_SNAPSHOT_FILE), "utf8"),
  );
  return declaredTablesFromSnapshot(parsed);
}

// The worktree DB name = the git worktree dir basename (a check subprocess has no
// runtime namespace), mirroring getWorktreeSlug in the check CLI.
async function getWorktreeName(): Promise<string> {
  return basename(await getWorktreeRoot());
}

const check: Check = {
  id: "orphaned-db-tables",
  description:
    "no orphaned public base tables: every live worktree-DB table is declared by a plugin's drizzle schema or in the imperative allowlist (catches dead schema left by imperative DROP/rename). Asserted only once the DB has applied every migration on disk",
  // Impure: reads the live worktree DB. Never cache.
  cacheSignature: () => null,
  async run(ctx) {
    const declared = loadDeclaredTables();
    const worktreeName = await getWorktreeName();

    const result = await withDirectDb(
      worktreeName,
      async (pool): Promise<CheckResult> => {
        // SECOND PRECONDITION — the live DB must be caught up with the migration
        // chain. This check compares the live table set against the HEAD drizzle
        // snapshot, and that comparison is only well-formed once every migration
        // on disk has been applied: with a migration still pending, the live
        // schema is a PAST state of the chain, so anything a pending migration
        // drops is live-but-undeclared by construction — not dead schema.
        //
        // This is not hypothetical, and getting it wrong DEADLOCKS the build:
        // `./singularity build` runs checks BEFORE the server restart that applies
        // migrations, so a freshly-authored `DROP TABLE` migration fails this
        // check on every build, and the build never reaches the step that would
        // apply it and make the check pass. (It did: `staged_config_default`,
        // dropped by 20260801_152825_266d6b7e, wedged main's build.)
        //
        // So: decline to assert while the DB is behind, exactly as with the
        // connect precondition (the non-ok arms below). Nothing is silenced — the
        // same build applies the pending migrations on restart, so the very next
        // run asserts against a caught-up DB and reports any real orphan then.
        let appliedHashes: Set<string>;
        try {
          const ledger = await queryRows(pool, {
            sql: `SELECT hash FROM ${MIGRATIONS_TABLE_NAME}`,
            row: z.object({ hash: z.string() }),
          });
          appliedHashes = new Set(ledger.map((r) => r.hash));
        } catch (e) {
          // No ledger table (42P01) = a DB that has never run the migration
          // runner: it is behind by the WHOLE chain, so there is nothing to
          // assert against. Any other error is a real fault and propagates.
          if ((e as { code?: string }).code === "42P01") return { ok: true };
          throw e;
        }
        const pending = pendingMigrationFiles(
          readdirSync(DATA_DIR),
          appliedHashes,
        );
        if (pending.length > 0) {
          ctx.log?.(
            `orphaned-db-tables: not asserting — worktree DB "${worktreeName}" is behind ` +
              `by ${pending.length} unapplied migration(s) (${pending.join(", ")}), so its ` +
              `schema is not expected to match the head snapshot yet. Re-asserts once ` +
              `the server restart applies them.`,
            "stdout",
          );
          return { ok: true };
        }

        const liveRows = await queryRows(pool, {
          // `relname` is a `name`, cast so the column decodes as the `text` the
          // schema declares.
          sql: `SELECT relname::text AS relname FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname`,
          row: z.object({ relname: z.string() }),
        });
        const live = liveRows.map((r) => r.relname);
        const orphans = computeOrphans(
          live,
          declared,
          IMPERATIVE_PUBLIC_TABLE_NAMES,
        );
        if (orphans.length === 0) return { ok: true };
        return {
          ok: false,
          message:
            `Orphaned public table(s) in worktree DB "${worktreeName}" — present in the live DB but ` +
            `not declared by any plugin's drizzle schema nor in the imperative allowlist:\n` +
            orphans.map((t) => `  - ${t}`).join("\n"),
          hint:
            "These are likely dead schema left behind by an imperative DROP/rename. " +
            "If the drop was intended, author a proper schema migration that drops them " +
            "(`./singularity build --migration-name drop_<table>`). " +
            "If the drop was unintended, restore the table's declaration in its plugin's tables.ts.",
        };
      },
    );
    switch (result.kind) {
      case "ok":
        return result.value;
      case "unreachable":
      case "no-database":
        // The live DB being reachable is an environmental PRECONDITION, not
        // this check's subject — "cannot look" is never evidence of dead
        // schema, so it must never block push. The cluster may legitimately be
        // down in the push checks subprocess (push doesn't bring the app up —
        // the reason migration-applies-clean fast-paths out without
        // connecting), and a not-yet-provisioned worktree fork (3D000) has no
        // tables at all. Decline to assert (clean pass). Nothing is silenced:
        // whenever the DB IS reachable (build, manual `check`, healthy push) a
        // real orphan still fails loudly.
        return { ok: true };
    }
  },
};

export default check;
