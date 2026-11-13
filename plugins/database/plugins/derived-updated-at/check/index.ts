import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  askSchemaFiles,
  firstFileOfEachTable,
  splitSchemaAnswers,
} from "@plugins/database/plugins/migrations/plugins/schema-question/core";
import type { DeclaredAnswer } from "./internal/declared.question";

const QUESTION = new URL("./internal/declared.question.ts", import.meta.url)
  .href;

// Closes the derived-updatedAt set: a column named `updated_at` means "derived",
// with no exceptions. Static (the schema globs are the complete,
// runtime-independent set of drizzle tables) rather than a boot assert, because
// a composition namespace loads only some plugins, so its registry is
// legitimately partial. Plan: research/2026-09-25-global-derived-updated-at-raw-tables.md.
const declaredCheck: Check = {
  id: "derived-updated-at:declared",
  description:
    "every drizzle schema table with an updated_at column declares how it moves (defineEntity meta.updatedAt / deriveUpdatedAt)",
  async run(ctx) {
    const probe = await askSchemaFiles<DeclaredAnswer>(await ctx.repo(), {
      name: "derived-updated-at:declared",
      module: QUESTION,
    });
    if (probe.kind === "probe-failed") {
      return { ok: false, message: probe.message };
    }
    const { loaded, loadFailures } = splitSchemaAnswers(probe.answers);
    const undeclared = firstFileOfEachTable(loaded);
    const problems: string[] = [];
    if (loadFailures.length > 0) {
      problems.push(
        `${loadFailures.length} schema file(s) failed to load, so their tables were not inspected:\n` +
          loadFailures.map((f) => `  ${f.file} — ${f.error}`).join("\n"),
      );
    }
    if (undeclared.length > 0) {
      problems.push(
        `${undeclared.length} table(s) have an updated_at column with no derived-updatedAt declaration ` +
          `(it is stamped by hand, so a no-op write moves it and a forgotten stamp does not):\n` +
          undeclared.map((u) => `  ${u.table} — ${u.file}`).join("\n"),
      );
    }
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: problems.join("\n\n"),
      hint:
        "A column named updated_at is derived by the database, never stamped. Declare how it moves: " +
        "wrap a raw pgTable in deriveUpdatedAt(pgTable(…), { touchedBy: { … } }) " +
        "(@plugins/database/plugins/derived-updated-at/server), or give a defineEntity table " +
        "meta.updatedAt: { touchedBy }. A write-time or heartbeat stamp must be spelled " +
        "differently (e.g. persisted_at). See plugins/database/plugins/derived-updated-at/CLAUDE.md.",
    };
  },
};

export default declaredCheck;
