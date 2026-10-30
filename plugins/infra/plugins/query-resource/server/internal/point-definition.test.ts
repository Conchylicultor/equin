/**
 * A compiled point read's handoff definition (`./point-definition`): what the
 * epoch handoff inherits a `:rows` tuple under across a restart. A value that
 * no longer equals the old one must move it; anything a fingerprint cannot
 * read must leave the read with none (never inherited). Pinned here:
 *
 *   - rendered lazily (never at the compile, which runs at module eval) and
 *     stable across two compiles of one declaration;
 *   - it moves with the projection, the static `where`, the row schema, the id
 *     bound and an `encodeRow`'s id;
 *   - none for a function `where`, an `encodeRow` naming no id, an opaque
 *     decoder or an opaque schema part.
 */

import { describe, expect, test } from "bun:test";
import { eq, sql, type SQL } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { PointQueryResourceContract } from "@plugins/infra/plugins/query-resource/core";
import { recordingQueryDb } from "../testing/recording-db";
import { compileWindowQuery } from "./compile-window";
import type { PointQueryResourceSpec } from "./spec";

const items = pgTable("pd_items", {
  id: text("id").primaryKey(),
  title: text("title"),
  state: text("state"),
});

function contract(
  o: { schema?: z.ZodType; maxIds?: number } = {},
): PointQueryResourceContract<{ id: string }> {
  return {
    key: "pd-items:rows",
    schema:
      o.schema ??
      z.array(z.object({ id: z.string(), title: z.string().nullable() })),
    keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
    queryPk: "id",
    point: {
      decode: (p: Record<string, string>) =>
        p.ids === "" || p.ids === undefined ? [] : p.ids.split(","),
      encode: (ids: readonly string[]) => ({ ids: [...ids].sort().join(",") }),
      maxIds: o.maxIds ?? 100,
    },
    validateParams: () => {},
  } as unknown as PointQueryResourceContract<{ id: string }>;
}

type Spec = PointQueryResourceSpec<Record<string, string>>;

function answerOf(
  spec: Partial<Spec> = {},
  c: Parameters<typeof contract>[0] = {},
): ReturnType<
  NonNullable<
    ReturnType<
      typeof compileWindowQuery
    >["serverOpts"]["routes"]["handoffDefinition"]
  >
> {
  const { db, calls } = recordingQueryDb();
  const compiled = compileWindowQuery(contract(c), {
    from: items,
    select: { id: items.id, title: items.title },
    point: { by: items.id },
    db,
    ...spec,
  } as Spec);
  // Nothing rendered at the compile: the definition is a thunk.
  expect(calls).toHaveLength(0);
  const thunk = compiled.serverOpts.routes.handoffDefinition;
  if (thunk === undefined) throw new Error("a point read carries a thunk");
  return thunk();
}

function definitionOf(
  spec: Partial<Spec> = {},
  c: Parameters<typeof contract>[0] = {},
): string | null {
  const answer = answerOf(spec, c);
  return answer.kind === "defined" ? answer.definition : null;
}

describe("a point read's handoff definition", () => {
  test("is stable across two compiles of one declaration", () => {
    const a = definitionOf();
    expect(a).toEqual(expect.any(String));
    expect(definitionOf()).toBe(a);
  });

  test("moves with the projection, the where, the schema, the id bound and the encodeRow id", () => {
    const base = definitionOf();
    const moved = [
      definitionOf({ select: { id: items.id, title: items.state } }),
      definitionOf({ where: eq(items.state, "open") as SQL }),
      definitionOf(
        {},
        {
          schema: z.array(
            z.object({
              id: z.string(),
              title: z.string().nullable(),
              x: z.number().optional(),
            }),
          ),
        },
      ),
      definitionOf({}, { maxIds: 50 }),
      definitionOf({ encodeRow: (r) => r, encodeRowId: "fold:a" }),
    ];
    for (const d of moved) {
      expect(d).toEqual(expect.any(String));
      expect(d).not.toBe(base);
    }
    expect(
      definitionOf({ encodeRow: (r) => r, encodeRowId: "fold:b" }),
    ).not.toBe(moved[4]);
  });

  test("is none for a function where, an encodeRow naming no id, an opaque decoder or schema", () => {
    expect(
      definitionOf({
        where: (() => eq(items.state, "open")) as unknown as SQL,
      }),
    ).toBeNull();
    expect(definitionOf({ encodeRow: (r) => r })).toBeNull();
    expect(
      definitionOf({
        select: {
          id: items.id,
          title: sql<string>`upper(${items.title})`.mapWith((v: unknown) =>
            String(v),
          ),
        },
      }),
    ).toBeNull();
    expect(
      definitionOf(
        {},
        {
          schema: z.array(
            z.object({
              id: z.string(),
              title: z
                .string()
                .nullable()
                .transform((v) => v ?? ""),
            }),
          ),
        },
      ),
    ).toBeNull();
  });
});
