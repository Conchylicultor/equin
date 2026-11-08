import { describe, expect, test } from "bun:test";
import { eventField, resolveEventFields } from "./event-field";

describe("resolveEventFields", () => {
  test("replaces a reference by the payload's field and keeps constants", () => {
    expect(
      resolveEventFields(
        { pageId: eventField("pageId"), mode: "full" },
        { pageId: "block-1", other: 2 },
      ),
    ).toEqual({ ok: true, input: { pageId: "block-1", mode: "full" } });
  });

  test("survives the trip through the trigger row's JSON", () => {
    const stored = JSON.parse(
      JSON.stringify({ pageId: eventField("pageId") }),
    ) as Record<string, unknown>;
    expect(resolveEventFields(stored, { pageId: "p" })).toEqual({
      ok: true,
      input: { pageId: "p" },
    });
  });

  test("names the fields the payload lacks", () => {
    expect(
      resolveEventFields({ pageId: eventField("pageId") }, { id: "x" }),
    ).toEqual({ ok: false, missing: ["pageId"] });
  });

  test("an object that merely contains the marker key is a constant", () => {
    const value = { $eventField: "pageId", extra: 1 };
    expect(resolveEventFields({ value }, { pageId: "p" })).toEqual({
      ok: true,
      input: { value },
    });
  });
});
