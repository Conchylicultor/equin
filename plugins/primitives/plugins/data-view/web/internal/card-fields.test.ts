import { describe, expect, test } from "bun:test";
import type { FieldDef } from "../../core";
import { partitionCardFields } from "./card-fields";

type Row = { id: string };

const f = (id: string, extra: Partial<FieldDef<Row>> = {}): FieldDef<Row> => ({
  id,
  label: id,
  value: (r) => r.id,
  ...extra,
});

const ids = (fields: readonly FieldDef<Row>[]) => fields.map((x) => x.id);

describe("partitionCardFields", () => {
  test("title, subtitle (text), tokens (other types), in body order", () => {
    const p = partitionCardFields([
      f("name", { primary: true }),
      f("size", { type: "number" }),
      f("author"),
      f("kind", { type: "enum", options: [] }),
      f("notes", { type: "text" }),
    ]);
    expect(p.title?.id).toBe("name");
    expect(ids(p.subtitle)).toEqual(["author", "notes"]);
    expect(ids(p.tokens)).toEqual(["size", "kind"]);
    expect(p.indicators).toEqual([]);
    expect(p.leading).toBeUndefined();
  });

  test("indicators leave the subtitle and tokens, whatever their type", () => {
    const p = partitionCardFields([
      f("name"),
      f("problems", { type: "number", indicator: true }),
      f("dirty", { indicator: true }),
    ]);
    expect(ids(p.indicators)).toEqual(["problems", "dirty"]);
    expect(p.subtitle).toEqual([]);
    expect(p.tokens).toEqual([]);
  });

  test("the leading field is never the title nor a line", () => {
    const p = partitionCardFields([
      f("avatar", { type: "avatar", leading: true }),
      f("name"),
      f("count", { type: "number" }),
    ]);
    expect(p.leading?.id).toBe("avatar");
    expect(p.title?.id).toBe("name");
    expect(ids(p.tokens)).toEqual(["count"]);
  });

  test("the cover and media fields are the picture, never text", () => {
    const p = partitionCardFields([
      f("name"),
      f("art", { type: "media" }),
      f("thumb", { type: "url", cover: true }),
      f("year", { type: "number" }),
    ]);
    expect(p.title?.id).toBe("name");
    expect(ids(p.tokens)).toEqual(["year"]);
    expect(p.subtitle).toEqual([]);
  });

  test("no text field: the first field is the title", () => {
    const p = partitionCardFields([
      f("n", { type: "number" }),
      f("m", { type: "number" }),
    ]);
    expect(p.title?.id).toBe("n");
    expect(ids(p.tokens)).toEqual(["m"]);
  });

  test("empty schema: nothing", () => {
    const p = partitionCardFields<Row>([]);
    expect(p.title).toBeUndefined();
    expect(p.subtitle).toEqual([]);
    expect(p.tokens).toEqual([]);
  });
});

test("an indicator is never picked as the title", () => {
  const p = partitionCardFields([f("dirty", { indicator: true }), f("name")]);
  expect(p.title?.id).toBe("name");
  expect(ids(p.indicators)).toEqual(["dirty"]);
});
