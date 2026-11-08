import type { Check } from "@plugins/framework/plugins/tooling/core";
import { schemaFilesIn } from "@plugins/database/plugins/migrations/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { resolve } from "path";
import { scanSqlWrites } from "./internal/scan";
import type { IssueKind } from "./internal/validate";

// Every hand-written SQL write in source, parsed by Postgres's own grammar
// (libpg_query) and validated against the schema the code declares — drizzle
// schema tables with their derived `updated_at` and generated columns, plus the
// hand-written DDL. See this plugin's CLAUDE.md.

/** Which exemptable id an issue kind is reported under (null: none admits one). */
const EXEMPTABLE: Readonly<Record<IssueKind, ExemptId | null>> = {
  dynamic: "sql-writes:fit:dynamic",
  "unknown-table": "sql-writes:fit:schema",
  "unknown-column": "sql-writes:fit:schema",
  "positional-insert": "sql-writes:fit:schema",
  "missing-required": "sql-writes:fit:schema",
  // The database refuses it at runtime, every time: never sanctioned, never debt.
  derived: null,
};
type ExemptId = "sql-writes:fit:dynamic" | "sql-writes:fit:schema";

const check: Check = {
  id: "sql-writes:fit",
  description:
    "every hand-written SQL write (INSERT / UPDATE / DELETE / MERGE, in CTEs too) parses and fits the declared schema: known tables and columns, every required column inserted, no write to a derived updated_at or generated column",
  exemptable: {
    "sql-writes:fit:dynamic":
      "writes a table or columns its source does not spell (an interpolated name or list), or a sql`…` statement that does not parse — so the write cannot be checked",
    "sql-writes:fit:schema":
      "writes a table or column the code does not declare, an INSERT without a column list, or an INSERT missing a required column",
  },
  outOfScope: ["test", "research", "generated"],
  async run(ctx) {
    const repo = await ctx.repo();
    const root = repo.root;
    const schemaFiles = schemaFilesIn(repo).map((f) => resolve(root, f));
    const candidates = repo
      .under("plugins")
      .filter(
        (f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts") && ctx.inScope(f),
      );
    const scan = await scanSqlWrites({
      root,
      files: candidates,
      read: (f) => repo.read(f),
      readSync: (abs) => {
        try {
          return readFileSync(abs, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
      },
      schemaFiles,
    });
    if (scan.kind === "failed") return { ok: false, message: scan.message };

    const exempt = {
      "sql-writes:fit:dynamic": await ctx.exempt("sql-writes:fit:dynamic"),
      "sql-writes:fit:schema": await ctx.exempt("sql-writes:fit:schema"),
    };
    const offenders = scan.issues.filter((i) => {
      const id = EXEMPTABLE[i.kind];
      return id === null || !exempt[id].skips(i.file);
    });
    ctx.log?.(
      `sql-writes: ${scan.writeSites} write site(s) checked in ${scan.files} file(s) ` +
        `(${scan.statements} write statement(s)); ${scan.issues.length} issue(s), ` +
        `${scan.issues.length - offenders.length} exempted`,
      "stdout",
    );
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${offenders.length} hand-written SQL write issue(s):\n` +
        offenders
          .map((i) => `  ${i.file}:${i.line} [${i.kind}] ${i.message}`)
          .join("\n"),
      hint:
        "Write through the table's typed handle (drizzle's insert/update builders, an entity extension's " +
        "upsert / upsertQuery — `onlyIf` for a guarded insert), which cannot name a derived or unknown column. " +
        "A derived updated_at is set by its touchedBy trigger: never write it. " +
        "A table made outside drizzle is declared by its hand-written table DDL in source. " +
        "A sanctioned generator that writes names it computes declares `sql-writes:dynamic` in its plugin's " +
        "exempt/index.ts. See plugins/database/plugins/sql-writes/CLAUDE.md.",
    };
  },
};

export default check;
