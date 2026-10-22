import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  classifyStatement,
  parseMigration,
  publishedMigrationBasenames,
  publishedMigrationRefsSignature,
  schemaMigrationFiles,
  snapshotLineage,
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

const MIGRATION_RE = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;

/** One migration file on disk. `file` is the `.sql` basename. */
export interface MigrationFile {
  file: string;
  sql: string;
  /** True when it is a schema migration (`isSchemaMigration`). */
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
 * - A merge node (a snapshot header with two or more parents) must be a no-op: empty sections,
 *   no claims and no supersedes. Its snapshot is a merge, not a diff, so any SQL
 *   in it would apply DDL no snapshot accounts for.
 *
 * And, over EVERY file (published too): an adoption file (an `adopts` header)
 * is not a schema migration and adopts only schema migrations (the runner's planner
 * checks each names an earlier phased file); a hash a `supersedes` header names must
 * not be a file on disk. A reset deletes what it supersedes; a superseded file
 * still present would run its DDL AND let the superseding file be adopted.
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
      (snapshotLineage(m.sql)?.parents.length ?? 0) > 1 &&
      (parsed.expand !== "" ||
        parsed.contract !== "" ||
        parsed.claims.length > 0 ||
        parsed.supersedes !== null)
    ) {
      errors.push(
        `${m.file}: a merge node must be a no-op (empty expand and contract, no claims, no supersedes)`,
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
  const fileByHash = new Map(
    files.map((m) => [MIGRATION_RE.exec(m.file)?.[3], m.file]),
  );
  const isSchemaByHash = new Map(
    files.map((m) => [MIGRATION_RE.exec(m.file)?.[3], m.isSchema]),
  );
  for (const m of files) {
    let parsed: ReturnType<typeof parseMigration>;
    try {
      parsed = parseMigration(m.sql);
    } catch (e) {
      // A branch-local schema file's parse error is already reported above.
      if (!m.isSchema || tracked.has(m.file))
        errors.push(`${m.file}: ${(e as Error).message}`);
      continue;
    }
    if (parsed.kind !== "phased" || parsed.supersedes === null) continue;
    if (parsed.adopts.length > 0) {
      if (m.isSchema)
        errors.push(
          `${m.file}: an adoption file is not a schema migration (no snapshot) — it records, it changes no schema`,
        );
      for (const h of parsed.adopts) {
        if (isSchemaByHash.get(h) === false)
          errors.push(
            `${m.file}: adopts ${fileByHash.get(h)}, which is not a schema migration`,
          );
      }
    }
    const lineage = [
      ...parsed.supersedes.direct,
      ...parsed.supersedes.inherited.flatMap((e) => [e.hash, ...e.replaced]),
    ];
    for (const h of new Set(lineage)) {
      const still = fileByHash.get(h);
      if (still !== undefined)
        errors.push(
          `${m.file}: supersedes ${h}, but ${still} is still on disk — a reset deletes what it supersedes`,
        );
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

    const schema = schemaMigrationFiles(DATA_DIR);
    const files = readdirSync(DATA_DIR)
      .filter((f) => MIGRATION_RE.test(f))
      .map((file) => ({
        file,
        sql: readFileSync(join(DATA_DIR, file), "utf8"),
        isSchema: schema.has(file),
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
