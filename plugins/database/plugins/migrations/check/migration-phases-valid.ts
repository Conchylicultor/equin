import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  classifyStatement,
  mergeSnapshotParents,
  parseMigration,
  publishedMigrationBasenames,
  publishedMigrationRefsSignature,
  splitStatements,
} from "@plugins/database/plugins/migrations/core";
// The runner's own planner validates the claims, so this check cannot drift
// from what boot would refuse.
import { planSchemaSteps } from "@plugins/database/plugins/migrations/server";
import { listMigrationFiles } from "@plugins/database/plugins/migrations/machine";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

// Inlined minimal Check shape (mirrors the sibling checks in this folder) to
// avoid a cross-plugin import of the framework Check type from a check file.
type CheckResult =
  | { ok: true }
  | { ok: false; message: string; hint?: string; inconclusive?: true };
type Check = {
  id: string;
  description: string;
  run(): Promise<CheckResult>;
  cacheSignature?(): string | null | Promise<string | null>;
};

const DATA_DIR = join(import.meta.dir, "..", "data");
const META_DIR = join(DATA_DIR, "meta");

const MIGRATION_RE = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;

/** One migration file on disk. `file` is the `.sql` basename. */
export interface MigrationFile {
  file: string;
  sql: string;
  /** True when a sibling `meta/<tag>_snapshot.json` exists. */
  isSchema: boolean;
}

/**
 * PURE core (exported for unit testing): every reason a BRANCH-LOCAL schema
 * migration (absent from `tracked`, the published basenames) was not produced by the
 * current generator, as one line each.
 *
 * - It must be phased — a legacy one would apply its contract before the data
 *   it claims.
 * - Each of its statements must re-classify into the section it sits in: an
 *   expand statement as expand, a contract statement as contract. That is what
 *   the generator wrote, so a mismatch is a hand-edit or a stale file.
 *
 * - A merge node (a `merge-snapshot` header) must be a no-op: empty sections
 *   and no claims. Its snapshot is a merge, not a diff, so any SQL in it would
 *   apply DDL no snapshot accounts for.
 *
 * Claims are validated by the runner's `planSchemaSteps` in `run()`.
 */
export function findPhaseErrors(
  files: readonly MigrationFile[],
  tracked: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  for (const m of files) {
    if (!m.isSchema || tracked.has(m.file)) continue;
    let parsed: ReturnType<typeof parseMigration>;
    try {
      parsed = parseMigration(m.sql);
    } catch (e) {
      errors.push(`${m.file}: ${(e as Error).message}`);
      continue;
    }
    if (parsed.kind === "legacy") {
      errors.push(
        `${m.file}: a branch-local schema migration without phase markers`,
      );
      continue;
    }
    if (
      mergeSnapshotParents(m.sql) !== null &&
      (parsed.expand !== "" ||
        parsed.contract !== "" ||
        parsed.claims.length > 0)
    ) {
      errors.push(
        `${m.file}: a merge node must be a no-op (empty expand and contract, no claims)`,
      );
      continue;
    }
    for (const phase of ["expand", "contract"] as const) {
      for (const stmt of splitStatements(parsed[phase])) {
        const cls = classifyStatement(stmt);
        if (cls.kind !== phase) {
          const oneLine = stmt.raw.replace(/\s+/g, " ").slice(0, 120);
          errors.push(
            `${m.file}: ${phase} statement classifies as ${cls.kind}${"op" in cls ? ` (${cls.op})` : ""}: ${oneLine}`,
          );
        }
      }
    }
  }
  return errors;
}

const check: Check = {
  id: "migration-phases-valid",
  description:
    "branch-local schema migrations are phased (expand / contract re-classify), and the runner's planner accepts every claim on disk",
  // Impure: reads the published refs via git. The data/ dir CONTENT is covered
  // by the runner's own tree hash — only the published refs need folding in.
  async cacheSignature(): Promise<string | null> {
    return publishedMigrationRefsSignature(await getWorktreeRoot());
  },
  async run() {
    const root = await getWorktreeRoot();
    const tracked = await publishedMigrationBasenames(root);

    const files = readdirSync(DATA_DIR)
      .filter((f) => MIGRATION_RE.test(f))
      .map((file) => ({
        file,
        sql: readFileSync(join(DATA_DIR, file), "utf8"),
        isSchema: existsSync(
          join(META_DIR, `${file.slice(0, -4)}_snapshot.json`),
        ),
      }));
    const errors = findPhaseErrors(files, tracked);
    // Claims: each resolves to exactly one earlier data migration, claimed once.
    // An empty applied set plans the whole history, as a fresh install would.
    try {
      planSchemaSteps(listMigrationFiles(DATA_DIR), new Set());
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (errors.length === 0) return { ok: true };
    return {
      ok: false,
      message: `phased migration(s) the runner would refuse:\n${errors.map((e) => `  ${e}`).join("\n")}`,
      hint:
        "Schema migrations are generator output — never hand-edit one. Regenerate this branch's with\n" +
        "  ./singularity build --reset-migration --migration-name <slug>\n" +
        "which re-phases it and re-claims the branch's data migrations. See\n" +
        "plugins/database/plugins/migrations/CLAUDE.md → 'Phased schema migrations'.",
    };
  },
};

export default check;
