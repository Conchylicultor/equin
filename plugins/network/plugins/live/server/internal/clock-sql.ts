import { sql } from "drizzle-orm";
import {
  expr,
  type ColumnRef,
  type ExprField,
} from "@plugins/infra/plugins/query-resource/core";
import { clockNow } from "@plugins/infra/plugins/query-resource/server";
import type { ClockForm } from "@plugins/network/plugins/live/core";

/**
 * The SQL rendering of a clock form (`clockField`, network/live core) over the
 * columns its inputs bind to: the value `clockFieldValue` (its JS rendering)
 * computes, against the tuple's pinned `now` (`clockNow()`, filled per tuple
 * at execution) — never Postgres's own clock. Switches over the same closed
 * set, so a new form is a type error here until it renders.
 */
export function clockFieldSql(
  form: ClockForm,
  reads: Readonly<Record<string, ColumnRef>>,
): ExprField<number | null> {
  const input = (name: string): ColumnRef => {
    const ref = reads[name];
    if (ref === undefined) {
      throw new Error(
        `clock field (${form.kind}): its input "${name}" is bound to no column`,
      );
    }
    return ref;
  };
  switch (form.kind) {
    case "elapsed": {
      const until =
        form.until === null
          ? clockNow()
          : sql`coalesce(${input(form.until)}, ${clockNow()})`;
      // `extract(epoch …)` yields `numeric`, which `pg` decodes as a string.
      return expr(
        sql`(extract(epoch from (${until} - ${input(form.from)})) * 1000)::double precision`,
        { decoder: Number, sqlType: "double precision" },
      );
    }
    default:
      return form.kind satisfies never;
  }
}
