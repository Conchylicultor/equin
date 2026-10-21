import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineThreadResult, resultCountOf } from "./result";

const picks = defineThreadResult({
  tool: "show_picks",
  schema: z.object({ ids: z.array(z.string()) }),
  count: (p) => p.ids.length,
});
const note = defineThreadResult({ tool: "note", schema: z.string() });

describe("resultCountOf", () => {
  test("counts each payload by its kind, one when it has no count", () => {
    expect(
      resultCountOf([
        { kind: "accepted", def: picks, payload: { ids: ["a", "b", "c"] } },
        { kind: "accepted", def: note, payload: "x" },
        { kind: "invalid" },
      ]),
    ).toBe(4);
  });
  test("nothing delivered is zero", () => {
    expect(resultCountOf([])).toBe(0);
  });
});
