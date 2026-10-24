import { schemaLoadFailures } from "@plugins/database/plugins/migrations/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

// Inlined minimal Check shape (mirrors the sibling migration checks) to avoid a
// cross-plugin import of the framework Check type from a check file.
type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  alwaysRun?: boolean;
  run(): Promise<CheckResult>;
};

const schemaFilesLoadableCheck: Check = {
  id: "schema-files-loadable",
  description:
    "every drizzle schema-glob file loads synchronously (drizzle-kit require())",
  // Cheap structural invariant: guard even `./equin build --skip-checks`.
  alwaysRun: true,
  async run() {
    // The probe is shared with `generateMigration`, which runs it before every
    // drizzle-kit generation; this check is the same question asked on every
    // check pass, so a broken file is named before anyone generates.
    const failures = await schemaLoadFailures(await getWorktreeRoot());

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
