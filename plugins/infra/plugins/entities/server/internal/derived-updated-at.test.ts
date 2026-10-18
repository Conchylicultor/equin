import { test, expect } from "bun:test";
import { z } from "zod";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import {
  compileFromTable,
  deriveUpdatedAt,
} from "@plugins/database/plugins/derived-updated-at/server";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { defineFieldType } from "@plugins/fields/core";
import type { FieldDef } from "@plugins/fields/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { entityRef } from "../../core";
import { defineEntity } from "./define-entity";
import { defaultNow } from "./types";

// ── Throwaway field types (own ids, so this file is independent of the
// define-entity suite that runs in the same process) ─────────────────────────
const textType = defineFieldType<string>("__dua_text__");
const dateType = defineFieldType<Date>("__dua_date__");

collectContributions([
  {
    id: "derived-updated-at-test",
    contributions: [
      Fields.Storage({ type: textType, build: (n) => text(n) }),
      Fields.Storage({
        type: dateType,
        build: (n) => timestamp(n, { withTimezone: true }),
      }),
    ],
  },
]);

function field<T>(
  type: ReturnType<typeof defineFieldType<T>>,
  schema: z.ZodType<T>,
  defaultValue: T,
): FieldDef<T> {
  return Object.freeze({ type, schema, defaultValue, meta: {} });
}

type Status = "idle" | "working" | "done";
function statusField(): FieldDef<Status> {
  return field(
    textType as unknown as ReturnType<typeof defineFieldType<Status>>,
    z.enum(["idle", "working", "done"]) as unknown as z.ZodType<Status>,
    "idle",
  );
}

function itemFields() {
  return {
    id: field(textType, z.string(), ""),
    title: field(textType, z.string(), ""),
    status: statusField(),
    lastViewedAt: field(dateType, z.coerce.date(), new Date(0)),
    updatedAt: field(dateType, z.coerce.date(), new Date(0)),
  };
}

// ── defineEntity: registration, physical names, runtime backstops ──────────

test("defineEntity compiles touchedBy from physical column names and registers it", () => {
  const entity = defineEntity(entityRef("dua_unit_items", itemFields()), {
    primaryKey: "id",
    columns: {
      lastViewedAt: { name: "seen_at" },
      updatedAt: { default: defaultNow() },
    },
    updatedAt: {
      touchedBy: {
        id: false,
        title: true,
        status: { into: ["working"] },
        lastViewedAt: true,
      },
    },
  });
  const spec = entity.derivedUpdatedAt;
  if (!spec) throw new Error("expected a derived updatedAt spec");
  expect(spec.functionDdl).toContain(
    `NEW."seen_at" IS DISTINCT FROM OLD."seen_at"`,
  );
  expect(spec.functionDdl).not.toContain(`last_viewed_at`);
  // Registered: the same table declared again with different rules conflicts.
  expect(() =>
    defineEntity(entityRef("dua_unit_items", itemFields()), {
      updatedAt: {
        touchedBy: {
          id: false,
          title: false,
          status: false,
          lastViewedAt: false,
        },
      },
    }),
  ).toThrow(/declared twice with different touchedBy rules/);
});

test("deriveUpdatedAt on a raw pgTable compiles the same spec as the equivalent defineEntity", () => {
  const touchedBy = {
    id: false,
    title: true,
    status: { into: ["working"], outOf: ["done"] },
    lastViewedAt: false,
  } as const;
  const entity = defineEntity(entityRef("dua_same_items", itemFields()), {
    primaryKey: "id",
    columns: {
      lastViewedAt: { name: "seen_at" },
      updatedAt: { default: defaultNow() },
    },
    updatedAt: { touchedBy },
  });
  const raw = pgTable("dua_same_items", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status").$type<Status>().notNull(),
    lastViewedAt: timestamp("seen_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  });
  // Registers the same table again: identical rules, so no conflict.
  deriveUpdatedAt(raw, { touchedBy });
  const spec = entity.derivedUpdatedAt;
  if (!spec) throw new Error("expected a derived updatedAt spec");
  expect(compileFromTable(raw, touchedBy)).toEqual(spec);
});

test("runtime backstops for callers typed against the widened record", () => {
  // As entity-extensions calls it: `FieldsRecord`-typed, invisible to the types.
  const defineLoose = defineEntity as unknown as (
    ref: object,
    meta: object,
  ) => unknown;
  const loose = (name: string, fields: Record<string, never>, meta: object) =>
    defineLoose(entityRef(name, fields), meta);
  expect(() => loose("dua_no_meta", itemFields() as never, {})).toThrow(
    /meta.updatedAt must declare/,
  );
  expect(() =>
    loose("dua_partial", itemFields() as never, {
      updatedAt: { touchedBy: { id: false, title: true, bogus: true } },
    }),
  ).toThrow(/missing: status, lastViewedAt; not a column: bogus/);
  expect(() =>
    loose("dua_no_field", { id: field(textType, z.string(), "") } as never, {
      updatedAt: { touchedBy: { id: false } },
    }),
  ).toThrow(/no updatedAt field/);
});

// ── Type tests (never run: they would register tables) ──────────────────────
// Each `@ts-expect-error` line is a declaration the types must refuse.
function _typeTests(): void {
  const f = itemFields();

  // An `updatedAt` field and no `meta.updatedAt` at all.
  // @ts-expect-error — meta is required when the record has updatedAt
  defineEntity(entityRef("t_no_meta", f));
  // @ts-expect-error — meta without an updatedAt declaration
  defineEntity(entityRef("t_meta_no_decl", f), { primaryKey: "id" });

  // A column nobody classified.
  const missingColumn = {
    updatedAt: { touchedBy: { id: false, title: true, status: true } },
  } as const;
  // @ts-expect-error — lastViewedAt is missing from touchedBy
  defineEntity(entityRef("t_missing_column", f), missingColumn);

  // A transition value that is not one of the column's values.
  const mistyped = {
    updatedAt: {
      touchedBy: {
        id: false,
        title: true,
        status: { into: ["wroking"] },
        lastViewedAt: false,
      },
    },
  } as const;
  // @ts-expect-error — "wroking" is not a Status
  defineEntity(entityRef("t_mistyped", f), mistyped);

  // A record WITHOUT updatedAt cannot declare one.
  const noUpdatedAt = { id: field(textType, z.string(), "") };
  const bogusDecl = { updatedAt: { touchedBy: { id: false } } } as const;
  // @ts-expect-error — no updatedAt field to derive
  defineEntity(entityRef("t_no_field", noUpdatedAt), bogusDecl);

  // The well-formed spellings compile.
  const ok = {
    updatedAt: {
      touchedBy: {
        id: false,
        title: true,
        status: { into: ["working", "done"], outOf: ["working"] },
        lastViewedAt: false,
      },
    },
  } as const;
  defineEntity(entityRef("t_ok", f), ok);
  // @ts-expect-error — the hand-stamped "app-managed" opt-out no longer exists
  defineEntity(entityRef("t_no_legacy", f), { updatedAt: "app-managed" });
  defineEntity(entityRef("t_ok_no_field", noUpdatedAt));
}
void _typeTests;
