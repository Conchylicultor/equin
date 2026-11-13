import {
  classifyStatement,
  migrationDataIn,
  publishedMigrationBasenames,
  publishedMigrationRefsSignature,
  schemaMigrationFilesIn,
  splitStatements,
  type MigrationFileSet,
} from "@plugins/database/plugins/migrations/core";
import {
  parseMigration,
  snapshotLineage,
} from "@plugins/database/plugins/migrations/plugins/phases/core";
// The runner's own planner validates the claims, so this check cannot drift
// from what boot would refuse.
import {
  isMigrationFileName,
  migrationsFrom,
  planSchemaSteps,
} from "@plugins/database/plugins/migrations/server";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

// Inlined minimal Check shape (mirrors the sibling checks in this folder) to
// avoid a cross-plugin import of the framework Check type from a check file.
type CheckResult =
  | { ok: true }
  | { ok: false; message: string; hint?: string; inconclusive?: true };
type Check = {
  id: string;
  description: string;
  run(ctx: {
    repo(): Promise<MigrationFileSet & { root: string }>;
  }): Promise<CheckResult>;
  cacheSignature?(): string | null | Promise<string | null>;
  inputKeyed?: boolean;
};

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
  // INPUT-KEYED: every file its verdict reads — the data dir's listing, each
  // migration, `meta/legacy-snapshots.json`, `meta/`'s listing — comes through
  // `ctx.repo()`, so an edit outside the data dir replays the verdict and
  // reads nothing. The published set (git) is the signature below: the files
  // on every published ref, a function of the refs' commits alone.
  inputKeyed: true,
  description:
    "branch-local schema migrations are phased (expand / contract re-classify), and the runner's planner accepts every claim on disk",
  // The published refs, read via git; the data dir's content is the read-set.
  async cacheSignature(): Promise<string | null> {
    return publishedMigrationRefsSignature(await getWorktreeRoot());
  },
  async run(ctx) {
    const repo = await ctx.repo();
    const root = await getWorktreeRoot();
    const tracked = await publishedMigrationBasenames(root);

    // Each file read once: the schema predicate reads a migration's header,
    // the phase checks and the planner its whole text — the same read.
    const reads = new Map<string, Promise<string | null>>();
    const data = migrationDataIn({
      under: (dir) => repo.under(dir),
      read(rel) {
        let text = reads.get(rel);
        if (text === undefined) reads.set(rel, (text = repo.read(rel)));
        return text;
      },
    });
    const schema = await schemaMigrationFilesIn(data);
    const files = await Promise.all(
      (await data.files()).filter(isMigrationFileName).map(async (file) => {
        const sql = await data.text(file);
        if (sql === null)
          throw new Error(`${file} was listed but cannot be read`);
        return { file, sql, isSchema: schema.has(file) };
      }),
    );
    const errors = findPhaseErrors(files, tracked);
    // Claims: each resolves to exactly one earlier data migration, claimed once.
    // An empty applied set plans the whole history, as a fresh install would.
    try {
      planSchemaSteps(
        migrationsFrom(files.map((f) => ({ file: f.file, sqlText: f.sql }))),
        new Set(),
      );
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (errors.length === 0) return { ok: true };
    return {
      ok: false,
      message: `phased migration(s) the runner would refuse:\n${errors.map((e) => `  ${e}`).join("\n")}`,
      hint:
        "Schema migrations are generator output — never hand-edit one. Regenerate this branch's with\n" +
        "  ./equin build --reset-migration --migration-name <slug>\n" +
        "which re-phases it and re-claims the branch's data migrations. See\n" +
        "plugins/database/plugins/migrations/CLAUDE.md → 'Phased schema migrations'.",
    };
  },
};

export default check;
