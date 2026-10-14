/**
 * A union collection (`arms`) reads several tables, so one table's
 * `serveCollection` never serves it: a tsc error (`SingleTableCollection`),
 * and a module-eval throw against a cast past it. Its arms' fields are bound
 * by the union's own server half (`serveUnionCollection`), never folded like
 * an exposure (T11).
 */

import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { recordingQueryDb } from "@plugins/infra/plugins/query-resource/server/testing";
import { liveCollection } from "../../core";
import { compileCollection, serveCollection } from "./serve-collection";

const runsT = pgTable("arms_runs", {
  runKey: text("run_key").primaryKey(),
  kind: text("kind").notNull(),
});

const Row = z.object({ runKey: z.string(), kind: z.string() });

describe("serveCollection refuses a union collection", () => {
  test("a module-eval throw against a cast past the type, and a tsc error", () => {
    const runs = liveCollection("test.live.serve-arms", {
      row: Row,
      id: "runKey",
      arms: { discriminator: "kind" },
      filterable: {},
      sortable: ["kind"],
      default: { orderBy: [["kind", "asc"]], limit: 10 },
      maxLimit: 30,
    });
    const { db } = recordingQueryDb();
    expect(() =>
      compileCollection(
        runs as unknown as Parameters<typeof compileCollection>[0],
        { from: runsT, db } as never,
      ),
    ).toThrow(/a union collection \(declared with `arms`\)/);
    // Never called — the assertion is the `@ts-expect-error`.
    const _typesOnly = () => {
      // @ts-expect-error — a union is not one table's collection
      serveCollection(runs, { from: runsT });
    };
    void _typesOnly;
  });
});
