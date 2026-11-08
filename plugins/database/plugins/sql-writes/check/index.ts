import type { Check } from "@plugins/framework/plugins/tooling/core";
import { schemaFilesIn } from "@plugins/database/plugins/migrations/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { resolve } from "path";
import { scanSqlWrites } from "./internal/scan";
import type { IssueKind } from "./internal/validate";
import { isInCategory } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

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

/**
 * Why an e2e script's writes need no declaration: it drives the deployed app
 * from outside and may import only `core` / `e2e` barrels, so the typed tables
 * (server code) are unreachable from it by the boundary rules — and its writes
 * are often the point (an out-of-band row the change feed must carry to the
 * page). Its statements are still parsed and fitted like every other.
 */
const HAND_WRITTEN_OUT_OF_SCOPE = "e2e" as const;

const check: Check = {
  id: "sql-writes:fit",
  description:
    "every hand-written SQL write (INSERT / UPDATE / DELETE / MERGE, in CTEs too) parses and fits the declared schema: known tables and columns, every required column inserted, no write to a derived updated_at or generated column — and, outside e2e scripts, is declared by its plugin (sql-writes:fit:hand-written) with the reason the typed path cannot express it",
  exemptable: {
    "sql-writes:fit:dynamic":
      "writes a table or columns its source does not spell (an interpolated name or list), or a sql`…` statement that does not parse — so the write cannot be checked",
    "sql-writes:fit:schema":
      "writes a table or column the code does not declare, an INSERT without a column list, or an INSERT missing a required column",
    "sql-writes:fit:hand-written":
      "writes the database with hand-written SQL instead of a typed handle (drizzle's insert / update / delete builders, an entity extension's upsert / upsertQuery, trimToNewest): a Postgres feature the typed path cannot express (a data-modifying or recursive CTE, UPDATE … FROM, graphile's own tables), a generator writing names it computes, or a table made outside drizzle",
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
    const fitOffenders = scan.issues.filter((i) => {
      const id = EXEMPTABLE[i.kind];
      return id === null || !exempt[id].skips(i.file);
    });
    // Every hand-written write is declared by the plugin that owns it — so a
    // NEW one fails here until it is either typed or given a reason.
    const handWritten = await ctx.exempt("sql-writes:fit:hand-written");
    const inScope = scan.writes.filter(
      (w) => !isInCategory(w.file, HAND_WRITTEN_OUT_OF_SCOPE),
    );
    // A declared file does not license every write in it: each site is bound
    // by its own marker comment, so a NEW raw write in a declared file fails
    // like one anywhere else, and a marker left behind by a removed write too.
    const undeclared = inScope.filter(
      (w) => w.marker === null || !handWritten.skips(w.file),
    );
    const stray = scan.strayMarkers.filter((m) => ctx.inScope(m.file));
    const offenders = [
      ...fitOffenders.map(
        (i) => `  ${i.file}:${i.line} [${i.kind}] ${i.message}`,
      ),
      ...undeclared.map((w) =>
        w.marker === null
          ? `  ${w.file}:${w.line} [hand-written] a hand-written write with no \`sql-writes:hand-written\` marker on its statement: ${oneLine(w.text)}`
          : `  ${w.file}:${w.line} [hand-written] a marked hand-written write in a file its plugin does not declare under sql-writes:fit:hand-written: ${oneLine(w.text)}`,
      ),
      ...stray.map((m) =>
        m.binds === 0
          ? `  ${m.file}:${m.line} [hand-written] a \`sql-writes:hand-written\` marker that binds no write (stale): remove it`
          : `  ${m.file}:${m.line} [hand-written] a \`sql-writes:hand-written\` marker that binds ${m.binds} writes: a marker declares one — give each write its own, on its own node`,
      ),
    ];
    ctx.log?.(
      `sql-writes: ${scan.writeSites} write site(s) checked in ${scan.files} file(s) ` +
        `(${scan.statements} write statement(s)); ${scan.issues.length} fit issue(s), ` +
        `${scan.issues.length - fitOffenders.length} exempted; ` +
        `${scan.writes.length - inScope.length} hand-written site(s) in e2e, ` +
        `${inScope.length - undeclared.length} declared and marked, ${undeclared.length} undeclared, ${stray.length} stray marker(s)`,
      "stdout",
    );
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${offenders.length} hand-written SQL write issue(s):\n` +
        offenders.join("\n"),
      hint:
        "Write through the table's typed handle (drizzle's insert/update builders, an entity extension's " +
        "upsert / upsertQuery — `onlyIf` for a guarded insert), which cannot name a derived or unknown column. " +
        "A derived updated_at is set by its touchedBy trigger: never write it. " +
        "A table made outside drizzle is declared by its hand-written table DDL in source. " +
        "A sanctioned generator that writes names it computes declares `sql-writes:fit:dynamic` in its plugin's " +
        "exempt/index.ts. A write the typed path genuinely cannot express is declared `sql-writes:fit:hand-written` " +
        'there, with the reason (kind "sanctioned"), or as debt naming the task that types it — and each such write carries a ' +
        "`// sql-writes:hand-written — <why this one>` comment on its statement. " +
        "See plugins/database/plugins/sql-writes/CLAUDE.md.",
    };
  },
};

export default check;

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}
