/**
 * An arm's bindings (`runsServed.arm`) are typed by value (T9): a column ref binds a
 * field only when the column reads as that field's type — its data type and
 * its nullability — so a wrong-typed column is a tsc error at the arm, not a
 * row the browser's parse refuses. The `@ts-expect-error` lines ARE the test:
 * `type-check` fails if any of them stops being an error.
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import { liveArm } from "@plugins/network/plugins/live/core";
import { runs } from "../../core";
import { runsServed } from "./served";

const ledgerRef = entityRef("rt_type_runs", {
  id: textField({ label: "Id" }),
  title: textField({ label: "Title" }),
  note: nullable(textField({ label: "Note" })),
  code: nullable(intField({ label: "Code" })),
  startedAt: dateField({ label: "Started" }),
  finishedAt: nullable(dateField({ label: "Finished" })),
});
const ledger = defineEntity(ledgerRef, { primaryKey: "id" }).table;

const columns = liveArm(runs, "typecheck", {
  label: "Typecheck",
  order: 10,
  from: ledgerRef,
  pick: ["code", "note"],
});

const outcome = expr(sql`'succeeded'`, {
  decoder: () => "succeeded" as const,
  sqlType: "text",
  notNull: true,
});

describe("runsServed.arm — bindings typed by value", () => {
  test("a column of the field's type binds; one of another type does not compile", () => {
    const ok = runsServed.arm(columns, {
      from: ledger,
      id: ledger.id,
      base: (j) => ({
        label: j.base.title,
        outcome,
        trigger: j.base.note,
        startedAt: j.base.startedAt,
        finishedAt: j.base.finishedAt,
        namespace: null,
        message: j.base.note,
      }),
      extra: (j) => ({ code: j.base.code, note: j.base.note }),
    });
    expect(ok.kind).toBe("typecheck");

    runsServed.arm(columns, {
      from: ledger,
      id: ledger.id,
      base: (j) => ({
        // @ts-expect-error an integer column is not a text label
        label: j.base.code,
        outcome,
        trigger: null,
        // @ts-expect-error a text column is not an instant
        startedAt: j.base.title,
        // @ts-expect-error a text column is not an instant, even a nullable one
        finishedAt: j.base.note,
        namespace: null,
        // @ts-expect-error an integer column is not a text message
        message: j.base.code,
      }),
      extra: (j) => ({
        // @ts-expect-error an arm-only field is checked too: text is not a number
        code: j.base.note,
        // @ts-expect-error an integer column is not a text field
        note: j.base.code,
      }),
    });
  });

  test("a nullable column cannot bind a NOT NULL field", () => {
    runsServed.arm(columns, {
      from: ledger,
      id: ledger.id,
      base: (j) => ({
        // @ts-expect-error `note` may be NULL; `label` may not
        label: j.base.note,
        outcome,
        trigger: null,
        // @ts-expect-error `finishedAt` may be NULL; `startedAt` may not
        startedAt: j.base.finishedAt,
        finishedAt: j.base.finishedAt,
        namespace: null,
        message: null,
      }),
      extra: (j) => ({ code: j.base.code, note: j.base.note }),
    });
  });

  test("the union's derived fields are never an arm's, and what they read is a column", () => {
    runsServed.arm(columns, {
      from: ledger,
      id: ledger.id,
      base: (j) => ({
        label: j.base.title,
        outcome,
        trigger: null,
        // @ts-expect-error `duration` is derived from `startedAt` / `finishedAt`, so it must be a column
        startedAt: expr(sql`now()`, {
          decoder: () => new Date(),
          sqlType: "timestamptz",
          notNull: true,
        }),
        finishedAt: j.base.finishedAt,
        namespace: null,
        message: null,
      }),
      extra: (j) => ({ code: j.base.code, note: j.base.note }),
    });
    runsServed.arm(columns, {
      from: ledger,
      id: ledger.id,
      base: (j) => ({
        label: j.base.title,
        outcome,
        trigger: null,
        startedAt: j.base.startedAt,
        finishedAt: j.base.finishedAt,
        namespace: null,
        message: null,
        // @ts-expect-error the union derives `duration` (and `id`): an arm binding one is refused
        duration: null,
      }),
      extra: (j) => ({ code: j.base.code, note: j.base.note }),
    });
  });
});
