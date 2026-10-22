import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
// The splitter is the migrations plugin's: the phaser, fork-schema-drift and
// this check read statements one way. So is what a schema migration is.
import {
  MIGRATIONS_DATA_DIR,
  schemaMigrationFiles,
  splitStatements,
} from "@plugins/database/plugins/migrations/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

// Statements a data/backfill migration may contain. DEFAULT-DENY: a statement is
// rejected unless it begins with one of these (after comment stripping). This is
// deliberately an allowlist, not a DDL blocklist — so schema-changing forms a
// blocklist would miss (CREATE EXTENSION, DO $$…$$, EXECUTE/dynamic SQL,
// CREATE TABLE AS, CREATE MATERIALIZED VIEW) can never slip through. A data
// migration therefore provably cannot change the schema and cannot drift from
// schema.ts the way a hand-rolled DDL migration could.
const ALLOWED_LEADING = /^(WITH|SELECT|INSERT|UPDATE|DELETE|SET\s+LOCAL)\b/i;

const check: Check = {
  id: "data-migration-dml-only",
  description:
    "data migrations (every migration but a schema one) contain only DML (no schema changes)",
  async run() {
    const root = await getWorktreeRoot();
    const dir = resolve(root, MIGRATIONS_DATA_DIR);
    const schema = schemaMigrationFiles(dir);

    const offenders: { file: string; statement: string }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".sql")) continue;
      // A data migration is any migration but a schema one (a snapshot header,
      // or a legacy-snapshots.json entry). Schema migrations are validated by
      // drizzle's own diff (migrations-in-sync).
      if (schema.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      for (const { code, raw } of splitStatements(sql)) {
        // SELECT ... INTO creates a table — reject despite the SELECT lead.
        // Read `code`, never `raw`: an `INTO` inside a string literal is data.
        const isSelectInto = /^SELECT\b/i.test(code) && /\bINTO\b/i.test(code);
        if (!ALLOWED_LEADING.test(code) || isSelectInto) {
          offenders.push({ file: f, statement: raw.slice(0, 80) });
          break;
        }
      }
    }

    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        "data migration(s) contain non-DML statements (schema changes are not allowed):\n" +
        offenders.map((o) => `  ${o.file}: ${o.statement}…`).join("\n"),
      hint:
        "Data/backfill migrations (created with --custom-migration) carry no drizzle " +
        "snapshot header and must run only DML (UPDATE/INSERT/DELETE/WITH/SELECT). To change " +
        "the schema, edit the plugin's schema.ts and run\n" +
        "  ./singularity build --migration-name <slug>\n" +
        "so drizzle generates a tracked schema migration instead.",
    };
  },
};

export default check;
