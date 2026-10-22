import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  findPublishedMigrationViolations,
  formatPublishedMigrationViolations,
  migrationContentHash,
  MIGRATIONS_DATA_DIR,
  PUBLISHED_MIGRATION_HINT,
  publishedMigrationBasenames,
  schemaMigrationFiles,
} from "@plugins/database/plugins/migrations/core";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { generateMigration } from "@plugins/framework/plugins/cli/plugins/migrations/cli";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

// Each migration filename embeds the sha256 prefix of its SQL content
// (see renameMigrations in migrations.ts). If the on-disk content of a
// branch-local migration no longer matches the embedded prefix, the agent
// hand-edited it — and auto-regen would silently discard those edits.
async function assertNoHandEditedBranchLocalMigrations(
  root: string,
): Promise<void> {
  const migrationsDir = resolve(root, MIGRATIONS_DATA_DIR);
  const published = await publishedMigrationBasenames(root);
  const schema = schemaMigrationFiles(migrationsDir);
  const offenders: { file: string; expected: string; actual: string }[] = [];
  for (const f of readdirSync(migrationsDir)) {
    if (!f.endsWith(".sql")) continue;
    if (published.has(f)) continue;
    // Data migrations are exempt: their SQL is hand-written by design and
    // their filename hash is self-healed on every build (see
    // rehashBranchLocalDataMigrations in migrations.ts). Only schema migrations —
    // whose SQL must match the snapshot's DDL — trigger the hand-edit abort.
    if (!schema.has(f)) continue;
    const m = f.match(/^\d{8}_\d{6}_([0-9a-f]{8})__/);
    if (!m) continue;
    const expected = m[1]!;
    const actual = migrationContentHash(readFileSync(join(migrationsDir, f)));
    if (expected !== actual) offenders.push({ file: f, expected, actual });
  }
  if (offenders.length === 0) return;
  console.error(
    "Hand-edited migration detected; auto-rebase would discard your edits.\n",
  );
  for (const o of offenders) {
    console.error(`  ${o.file}`);
    console.error(`    filename hash: ${o.expected}`);
    console.error(`    content  hash: ${o.actual}`);
  }
  console.error(
    "\nResolve the rebase manually: either revert the SQL hand-edits and re-run push, " +
      "or rebase by hand and accept the migration files yourself.",
  );
  process.exit(1);
}

// Published migrations are immutable by contract — their hashes are recorded in
// deployed DBs' `__singularity_migrations`, and their lineage is a link of the
// chain. The rule is the migrations plugin's (`findPublishedMigrationViolations`,
// also the `published-migrations-immutable` check), asserted here before the
// destructive reset because the regeneration would bake a violation in.
//
// This is also the guard that keeps the unconditional journal regeneration
// honest: the journal is derived from the `.sql` files on disk, so a deleted
// migration would otherwise just quietly lose its row.
async function assertPublishedMigrationsIntact(root: string): Promise<void> {
  const violations = await findPublishedMigrationViolations(root);
  if (violations.length === 0) return;
  console.error(
    `Published migration file(s) changed in the working tree:\n${formatPublishedMigrationViolations(violations)}\n`,
  );
  console.error(PUBLISHED_MIGRATION_HINT);
  process.exit(1);
}

function deriveMigrationName(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `merged_${yyyy}${mm}${dd}_${hh}${mi}`;
}

const run: CliAction<[], { name?: string }> = async (opts) => {
  const root = await getWorktreeRoot();
  await assertNoHandEditedBranchLocalMigrations(root);
  await assertPublishedMigrationsIntact(root);
  await generateMigration({
    root,
    migrationName: opts.name ?? deriveMigrationName(),
    resetMigration: true,
  });
};

export default run;
