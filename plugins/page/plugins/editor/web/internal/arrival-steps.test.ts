import { describe, expect, test } from "bun:test";
import type { Block } from "../../core";
import { arrivalSteps } from "./arrival-steps";

function row(
  id: string,
  parentId: string | null,
  type = "text",
): { block: Block } {
  // Only `id` / `parentId` matter to the step assignment.
  return { block: { id, parentId, type } as unknown as Block };
}

describe("arrivalSteps", () => {
  const rows = [
    row("old", "page"),
    row("shop1", "page", "todo"),
    row("place1", "shop1", "place"),
    row("shop2", "page", "todo"),
    row("blank", "page"),
    row("map", "page", "map"),
  ];
  const arrived = (b: Block) => b.id !== "old";
  const isEmpty = (b: Block) => b.id === "blank";

  test("one push cascades in document order; a child enters with its parent; an empty line has no entry", () => {
    const steps = arrivalSteps(rows, arrived, isEmpty);
    expect(steps.has("old")).toBe(false);
    expect(steps.get("shop1")).toEqual({ step: 0, steps: 3 });
    expect(steps.get("place1")).toEqual({ step: 0, steps: 3 });
    expect(steps.get("shop2")).toEqual({ step: 1, steps: 3 });
    expect(steps.get("blank")).toEqual({ step: null, steps: 3 });
    expect(steps.get("map")).toEqual({ step: 2, steps: 3 });
  });

  test("a single arriving row is step 0", () => {
    const steps = arrivalSteps(rows, (b) => b.id === "map", isEmpty);
    expect([...steps]).toEqual([["map", { step: 0, steps: 1 }]]);
  });

  test("a row under an arriving empty parent takes its own step", () => {
    const steps = arrivalSteps(
      [row("blank", "page"), row("kid", "blank")],
      () => true,
      isEmpty,
    );
    expect(steps.get("kid")).toEqual({ step: 0, steps: 1 });
  });
});
