/**
 * The `page_blocks.data` column's decoder, exercised on the REAL column rather
 * than a stand-in — `_blocks.data` itself, so what is pinned here is what ships.
 *
 * This is the one branded jsonb column in the repo, and the brand is the point:
 * `parseBlockData` is the only write-side mint, so a write that skipped
 * validation is a compile error. What the DECODER can and cannot claim is what
 * this suite pins, because both halves are easy to get wrong in opposite
 * directions:
 *
 *  - it must NOT be a `z.object` — the per-type schemas belong to ~35 block-type
 *    plugins and a decoder cannot know which one applies, so an object schema
 *    would strip every key it has not heard of, i.e. all of them;
 *  - it must still be a real check — a non-object row is a loud failure naming
 *    `page_blocks.data`, not a value typed code goes on to read fields off.
 */
import { describe, expect, test } from "bun:test";
import { jsonb, pgTable } from "drizzle-orm/pg-core";
import { SqlColumnError } from "@plugins/database/plugins/sql-column/server/testing";
import { asBlockData } from "@plugins/page/plugins/block-entity/core";
import { _blocks } from "./tables";

test("the column is a plain `jsonb`, so adopting the decoder needs no migration", () => {
  const plain = pgTable("t", { j: jsonb("j") });
  expect(_blocks.data.getSQLType()).toBe("jsonb");
  expect(_blocks.data.getSQLType()).toBe(plain.j.getSQLType());
});

describe("what it keeps", () => {
  test("every key survives, whichever block type wrote it", () => {
    // A callout's payload and a to-do's payload have nothing in common; the
    // decoder has heard of neither and must hand both back whole.
    const callout = { icon: "lightbulb", color: "amber" };
    const todo = { text: [{ text: "ship it" }], checked: true };
    expect(_blocks.data.mapFromDriverValue(callout)).toEqual(callout);
    expect(_blocks.data.mapFromDriverValue(todo)).toEqual(todo);
  });

  test("the write half keeps them too", () => {
    // `toDriver` is `JSON.stringify` of the PARSED value, so the encoded string
    // is asserted directly. A round trip through `JSON.parse` would pass even if
    // the encoder had dropped a key and something downstream re-added it.
    expect(
      _blocks.data.mapToDriverValue(
        asBlockData({ title: "Notes", icon: null, cover: { kind: "color" } }),
      ),
    ).toBe('{"title":"Notes","icon":null,"cover":{"kind":"color"}}');
  });

  test("an empty payload round-trips — that is the column's DDL default", () => {
    expect(_blocks.data.mapFromDriverValue({})).toEqual({});
  });
});

describe("what it refuses", () => {
  test("a non-object row throws, naming the qualified column", () => {
    let err: unknown;
    try {
      _blocks.data.mapFromDriverValue("page" as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SqlColumnError);
    const e = err as SqlColumnError;
    expect(e.label).toBe("page_blocks.data");
    expect(e.direction).toBe("read");
  });

  test("an array is not a block payload either", () => {
    expect(() => _blocks.data.mapFromDriverValue([] as never)).toThrow(
      SqlColumnError,
    );
  });
});
