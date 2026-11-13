import { describe, expect, test } from "bun:test";
import { defineIdKind } from "@plugins/ids/core";
import { idChipPattern, splitIdChipToken } from "./id-chip-pattern";

const kind = defineIdKind({ prefix: "thing", label: "Thing" });
const qualifier = /\?[a-z]+=[a-z0-9#]+(?:&[a-z]+=[a-z0-9#]+)*/;
const id = "thing-1794572799-wlene9";

function matches(text: string, q?: RegExp): string[] {
  return [...text.matchAll(idChipPattern(kind, q))].map((m) => m[0]);
}

describe("qualified id chip pattern", () => {
  test("takes the qualifier after the id", () => {
    expect(
      matches(`see ${id}?pane=floating&accent=#10b981 here`, qualifier),
    ).toEqual([`${id}?pane=floating&accent=#10b981`]);
  });
  test("an id alone, or one ending a question, is the plain id", () => {
    expect(matches(`did you see ${id}?`, qualifier)).toEqual([id]);
  });
  test("no qualifier declared: the plain pattern, one object per kind", () => {
    expect(matches(`${id}?pane=floating`)).toEqual([id]);
    expect(idChipPattern(kind)).toBe(idChipPattern(kind));
    expect(idChipPattern(kind, qualifier)).toBe(idChipPattern(kind, qualifier));
  });
  test("splits a token into id and qualifier", () => {
    expect(splitIdChipToken(kind, `${id}?pane=floating`)).toEqual({
      id,
      qualifier: "?pane=floating",
    });
    expect(splitIdChipToken(kind, id)).toEqual({ id, qualifier: "" });
    expect(() => splitIdChipToken(kind, "nope")).toThrow();
  });
});
