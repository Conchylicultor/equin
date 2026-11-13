import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  askSchemaFiles,
  firstFileOfEachTable,
  splitSchemaAnswers,
} from "@plugins/database/plugins/migrations/plugins/schema-question/core";
import type { PkAnswer } from "./pk.question";

const ID = "ids:pk-declared";
const QUESTION = new URL("./pk.question.ts", import.meta.url).href;

/**
 * Every table keyed by a single `id` column says what that id IS: a declared
 * kind (`idColumn(kind)` / `idKindField(kind)`), or an id minted elsewhere
 * (`externalIdColumn("id", { reason })`). A bare `text("id").primaryKey()` is an
 * id nothing declares — no mint, no recognition, no chip.
 *
 * Read off the BUILT tables, not their source: the schema question host loads
 * the schema files the way drizzle-kit does and asks each table's id column
 * how it was declared (`idColumnDeclaration`, `pk.question.ts`) — a record
 * keyed by every schema file's closure, so a pass whose edit reaches none
 * loads nothing. So a `defineEntity` whose field record
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
    const probe = await askSchemaFiles<PkAnswer>(await ctx.repo(), {
      name: ID,
      module: QUESTION,
    });
    if (probe.kind === "probe-failed") {
      return { ok: false, message: probe.message };
    }
    const { loaded, loadFailures } = splitSchemaAnswers(probe.answers);
    const problems: string[] = [];
    if (loadFailures.length > 0) {
      problems.push(
        `${loadFailures.length} schema file(s) failed to load, so their tables were not inspected:\n  ` +
          loadFailures.map((f) => `${f.file} — ${f.error}`).join("\n  "),
      );
    }
    const offenders = firstFileOfEachTable(loaded).filter(
      (u) => !exempt.skips(u.file),
    );
    if (offenders.length > 0) {
      problems.push(
        `${offenders.length} table id primary key(s) that name no id kind:\n  ` +
          offenders.map((u) => `${u.table} — ${u.file}`).join("\n  "),
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
