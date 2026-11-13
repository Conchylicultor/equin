import {
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { basename, join, resolve } from "path";
import { MIGRATIONS_TABLE_NAME } from "@plugins/database/plugins/derived-views/core";
import {
  classifyStatement,
  publishedMigrationRefsSignature,
  splitStatements,
  type StatementOp,
} from "@plugins/database/plugins/migrations/core";
import { queryRows } from "@plugins/database/plugins/sql-rows/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { z } from "zod";
import { withDirectDb } from "./internal/direct-db";

// Inlined minimal Check shape (mirrors the sibling checks in this folder, e.g.
// migration-applies-clean) to avoid a cross-plugin import of the framework Check
// type from a check file.
type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(): Promise<CheckResult>;
  cacheSignature?(): string | null | Promise<string | null>;
  wholeTreeRead?: { kind: "debt"; task: string; reason: string };
};

const MIGRATIONS_SUBDIR = "plugins/database/plugins/migrations/data";

// Filename → sha8 regex, inlined from the runner (server/internal/runner.ts) so
// this check never imports a server-plugin internal.
const MIGRATION_RE = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;

// Every migration filename under `dir` (matching MIGRATION_RE).
function migrationFileSet(dir: string): Set<string> {
  const files = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (MIGRATION_RE.test(f)) files.add(f);
  }
  return files;
}

// HARD-destructive ops: the old name is gone, so code still using it crashes a
// read path. Deliberately OUT (soft reshapes that rarely crash a read — revisit
// only if a real case appears): DROP CONSTRAINT, SET DATA TYPE, SET NOT NULL.
// Read from the shared statement table, so an unrecognised statement (a legacy
// file's view or DML) is simply not destructive here.
const DESTRUCTIVE_OPS: ReadonlySet<StatementOp> = new Set([
  "drop-table",
  "drop-column",
  "rename-table",
  "rename-column",
]);

// The destructive statements of one migration file, as one-line snippets.
function destructiveStatements(sql: string): string[] {
  return splitStatements(sql)
    .filter((stmt) => {
      const cls = classifyStatement(stmt);
      return "op" in cls && DESTRUCTIVE_OPS.has(cls.op);
    })
    .map((stmt) => {
      const oneLine = stmt.raw.replace(/\s+/g, " ").trim();
      return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
    });
}

// One migration per entry, each followed by its destructive statements.
function formatDetails(
  migrations: readonly { file: string; statements: readonly string[] }[],
): string {
  return migrations
    .map(
      (c) =>
        `  - ${c.file}\n${c.statements.map((s) => `      ${s}`).join("\n")}`,
    )
    .join("\n");
}

const check: Check = {
  id: "fork-schema-drift",
  wholeTreeRead: {
    kind: "debt",
    task: "task-1794579727-rjy6wx",
    reason: "reads every migration file (1.4k)",
  },
  description:
    "worktree DB carries no destructive migration absent from this branch",
  // Impure: reads the main worktree's data/ dir, which is outside this tree.
  // The data/ dir CONTENT here is already covered by the runner's own tree
  // hash (scope "tree", the default) — the published refs (local `main`, which
  // the main worktree has checked out, among them) are folded in.
  async cacheSignature(): Promise<string | null> {
    return publishedMigrationRefsSignature(await getWorktreeRoot());
  },
  async run() {
    const root = await getWorktreeRoot();
    const mainRoot = await ensureMainWorktreeRoot();
    const branchDataDir = resolve(root, MIGRATIONS_SUBDIR);
    const mainDataDir = join(mainRoot, MIGRATIONS_SUBDIR);

    // FAST PATH (no DB connection). The only drift this check blocks is a
    // migration that exists on main but is ABSENT from this branch — one the
    // forked DB may carry while this branch's code knows nothing about it. A
    // feature branch normally only ADDS migrations, so its set is a superset of
    // main's and there is nothing to check. This purely-filesystem comparison
    // keeps the ~99% case free and off the DB entirely (mirroring
    // migration-applies-clean's own connection-free fast path); we open a
    // connection only when main truly has a migration this branch lacks.
    const branchFiles = migrationFileSet(branchDataDir);
    const missingOnBranch = [...migrationFileSet(mainDataDir)].filter(
      (f) => !branchFiles.has(f),
    );
    if (missingOnBranch.length === 0) return { ok: true };

    // Keep only the DESTRUCTIVE ones — a code-breaking, rebase-fixable drift.
    // Still pure (classify main's on-disk files); no DB yet.
    const candidates = missingOnBranch
      .map((file) => ({
        file,
        statements: destructiveStatements(
          readFileSync(join(mainDataDir, file), "utf8"),
        ),
      }))
      .filter((c) => c.statements.length > 0);
    if (candidates.length === 0) return { ok: true };

    // A destructive migration on main is absent from this branch. Confirm the
    // worktree DB ACTUALLY applied it (a DB forked BEFORE the migration landed
    // never applied it → no real drift) by reading the ledger. Only now do we
    // open a direct (non-pgbouncer) connection to this worktree's own DB.
    const worktreeDb = basename(root);
    const ledger = await withDirectDb(worktreeDb, async (pool) => {
      try {
        const rows = await queryRows(pool, {
          sql: `SELECT hash FROM ${MIGRATIONS_TABLE_NAME}`,
          row: z.object({ hash: z.string() }),
        });
        return new Set(rows.map((r) => r.hash));
      } catch (e) {
        // No ledger table (42P01): the migration runner never ran on this DB,
        // so nothing was applied → no drift. Any other error propagates loudly.
        if ((e as { code?: string }).code === "42P01") return new Set<string>();
        throw e;
      }
    });

    // No database (3D000): an unforked worktree applied nothing → no drift.
    if (ledger.kind === "no-database") return { ok: true };

    // Could not connect. Stay FATAL rather than pass: letting the build go on
    // would restart the server on a DB that may be missing schema the code
    // still uses. Lead with what is known without the DB — the destructive
    // migrations main has and this branch lacks — because rebasing settles the
    // check whether or not the DB ever answers.
    if (ledger.kind === "unreachable") {
      return {
        ok: false,
        message:
          `Could not read this worktree's migration ledger (DB "${worktreeDb}"): ${ledger.cause}.\n` +
          `main has ${candidates.length} destructive migration(s) this branch lacks — ` +
          `if this DB applied them, your code may use schema they drop:\n` +
          formatDetails(candidates),
        hint: "Rebase onto `main` — that settles this check with or without the DB.",
      };
    }

    const appliedHashes = ledger.value;
    const confirmed = candidates.filter((c) => {
      const sha8 = MIGRATION_RE.exec(c.file)?.[3];
      return sha8 !== undefined && appliedHashes.has(sha8);
    });
    if (confirmed.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `This worktree's DB ("${worktreeDb}") applied ${confirmed.length} ` +
        `destructive migration(s) absent from this branch:\n${formatDetails(confirmed)}`,
      hint:
        "This worktree's DB has migrations your branch lacks that DROP/RENAME " +
        "schema your code may still use. Rebase onto `main` to pull them in.",
    };
  },
};

export default check;
