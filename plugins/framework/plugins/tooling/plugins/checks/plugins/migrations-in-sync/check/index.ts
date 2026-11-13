import type { Check } from "@plugins/framework/plugins/tooling/core";
import { drizzleInSyncVerdict } from "./internal/in-sync-record";

/**
 * The committed migrations match the schema files: `drizzle-kit generate`
 * over them would write nothing.
 *
 * Its answer is a function of the schema files' code, the drizzle config,
 * `data/` and the npm code, so it is a plugin record keyed by exactly those
 * (`internal/in-sync-record.ts`): drizzle-kit runs once per distinct input
 * host-wide (4–11 s), and a pass after an edit no schema file's closure
 * reaches — most of them — is a lookup over the module graph. A schema edit
 * moves the key and runs drizzle-kit, as before. What escapes the key, as for
 * every record (a schema module reading a file or the environment at load),
 * is caught by `./equin check --verify-records`, which recomputes it daily.
 */
const check: Check = {
  id: "migrations-in-sync",
  description: "plugin schema files match committed migration files",
  async run(ctx) {
    const verdict = await drizzleInSyncVerdict(await ctx.repo());
    if (!verdict.ok) return { ok: false, message: verdict.error };
    const v = verdict.value;
    switch (v.kind) {
      case "in-sync":
        return { ok: true };
      case "unjoined":
        return { ok: false, message: v.message };
      case "ambiguous":
        return {
          ok: false,
          message:
            "Schema has ambiguous changes (rename vs create) requiring interactive resolution.",
          hint:
            "Run `./equin build --migration-name <slug>` to see the detected prompts " +
            "and provide explicit --migration-answers.\n\n" +
            "AGENT: Stop here and report this to the user. Do not retry or work around this. " +
            "If this check fails unexpectedly, report the limitation clearly.",
        };
      case "diverges":
        return {
          ok: false,
          message: `plugin schema files diverge from committed migrations (would add: ${v.added.join(", ")})`,
          hint: "Run `./equin build` and commit the generated migration files.",
        };
    }
  },
};

export default check;
