import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  askSchemaFiles,
  splitSchemaAnswers,
} from "@plugins/database/plugins/migrations/plugins/schema-question/core";

const QUESTION = new URL("./loads.question.ts", import.meta.url).href;

const schemaFilesLoadableCheck: Check = {
  id: "schema-files-loadable",
  description:
    "every drizzle schema-glob file loads synchronously (drizzle-kit require())",
  // Cheap structural invariant: guard even `./equin build --skip-checks`.
  alwaysRun: true,
  async run(ctx) {
    // Every file loaded the way drizzle-kit loads them, by the schema question
    // host — a record keyed by every schema file's closure, so a pass whose
    // edit reaches none loads nothing. `generateMigration` still loads every file itself (`probeSchema`)
    // before it trusts a drizzle-kit run; this check names a broken file on
    // every pass, before anyone generates.
    const probe = await askSchemaFiles<null>(await ctx.repo(), {
      name: "schema-files-loadable",
      module: QUESTION,
    });
    if (probe.kind === "probe-failed")
      return { ok: false, message: probe.message };
    const failures = splitSchemaAnswers(probe.answers).loadFailures;

    if (failures.length > 0) {
      return {
        ok: false,
        message:
          `${failures.length} schema file(s) cannot be synchronously loaded by drizzle-kit ` +
          `(they would be SILENTLY SKIPPED during migration generation):\n` +
          failures.map((f) => `  ${f.file} — ${f.error}`).join("\n"),
        hint:
          "A schema file's import graph pulls in a module that cannot load outside a " +
          "running backend — an async-only one (top-level await, e.g. lexical/@lexical/yjs) " +
          "or one that throws at module eval (e.g. it asks for a runtime namespace) — " +
          "often reached through a plugin barrel. Keep tables.ts/schema.ts a leaf that " +
          "imports only modules safe to load anywhere; move the offending import out of its graph.",
      };
    }
    return { ok: true };
  },
};

export default schemaFilesLoadableCheck;
