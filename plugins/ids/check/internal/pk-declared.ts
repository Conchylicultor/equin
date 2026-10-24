import { relative, resolve } from "path";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { schemaGlobFiles } from "@plugins/database/plugins/migrations/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { runPkProbe } from "./run-pk-probe";

const ID = "ids:pk-declared";

/**
 * Every table keyed by a single `id` column says what that id IS: a declared
 * kind (`idColumn(kind)` / `idKindField(kind)`), or an id minted elsewhere
 * (`externalIdColumn("id", { reason })`). A bare `text("id").primaryKey()` is an
 * id nothing declares — no mint, no recognition, no chip.
 *
 * Read off the BUILT tables, not their source: a probe subprocess loads every
 * schema file the way drizzle-kit does and asks each table's id column how it
 * was declared (`idColumnDeclaration`). So a `defineEntity` whose field record
 * lives in another module counts the same as an inline `idColumn`. A table not
 * yet migrated is declared as `debt` in its own plugin's `exempt/index.ts`
 * (the schema file's path), so the rule is on from day one and the debt is
 * listed by `./equin exempt list --rule ids:pk-declared`.
 */
export const pkDeclared: Check = {
  id: ID,
  description:
    "every table keyed by a single `id` column declares it with idColumn / idKindField (a declared id kind) or externalIdColumn (an id minted elsewhere)",
  outOfScope: ["test", "e2e", "script"],
  exemptable: {
    [ID]: 'keys a table by an `id` column that names no id kind (raw `text("id").primaryKey()` / a `defineEntity` id field that is not `idKindField`)',
  },
  async run(ctx): Promise<CheckResult> {
    const exempt = await ctx.exempt(ID);
    const root = await getWorktreeRoot();
    const absFiles = (await schemaGlobFiles(root)).map((f) => resolve(root, f));
    const probe = await runPkProbe(root, absFiles);
    if (probe.kind === "probe-failed") {
      return { ok: false, message: probe.message };
    }
    const problems: string[] = [];
    if (probe.loadFailures.length > 0) {
      problems.push(
        `${probe.loadFailures.length} schema file(s) failed to load, so their tables were not inspected:\n  ` +
          probe.loadFailures
            .map((f) => `${relative(root, f.file)} — ${f.error}`)
            .join("\n  "),
      );
    }
    const offenders = probe.undeclared
      .map((u) => ({ ...u, rel: relative(root, u.file) }))
      .filter((u) => !exempt.skips(u.rel));
    if (offenders.length > 0) {
      problems.push(
        `${offenders.length} table id primary key(s) that name no id kind:\n  ` +
          offenders.map((u) => `${u.table} — ${u.rel}`).join("\n  "),
      );
    }
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: problems.join("\n\n"),
      hint:
        "Declare the kind in the owning plugin's core/ (`defineIdKind`, `@plugins/ids/core`) and key " +
        "the table with `idColumn(kind)` (`@plugins/ids/server`) or, in a defineEntity record, " +
        '`idKindField(kind)`. An id minted elsewhere (Gmail, YouTube) is `externalIdColumn("id", { reason })`. ' +
        "A table you cannot migrate in this change is `debt` in your plugin's exempt/index.ts, with a task.",
    };
  },
};
