import { expect, test } from "bun:test";
import {
  createLinkedHover,
  deriveLinkedHover,
  nextLinkedHover,
} from "./linked-hover";

test("an enter claims the hover", () => {
  expect(nextLinkedHover(null, "a", true)).toBe("a");
  expect(nextLinkedHover("b", "a", true)).toBe("a");
});

test("a leave releases only its own id", () => {
  expect(nextLinkedHover("a", "a", false)).toBeNull();
  expect(nextLinkedHover("b", "a", false)).toBe("b");
  expect(nextLinkedHover(null, "a", false)).toBeNull();
});

test("the surface left reporting after the surface entered keeps the new hover", () => {
  // Pointer from pin "a" onto row "b": the row's enter lands first.
  const afterEnter = nextLinkedHover("a", "b", true);
  expect(nextLinkedHover(afterEnter, "a", false)).toBe("b");
});

test("the store notifies only on a change", () => {
  const hover = createLinkedHover();
  let calls = 0;
  const off = hover.subscribe(() => calls++);
  hover.report("a", true);
  hover.report("a", true);
  hover.report("b", false); // releasing an id nobody holds: no change
  expect(hover.get()).toBe("a");
  expect(calls).toBe(1);
  hover.report("a", false);
  expect(hover.get()).toBeNull();
  expect(calls).toBe(2);
  off();
  hover.report("c", true);
  expect(calls).toBe(2);
});

test("a derived hover reads through its sources and routes its reports", () => {
  const places = createLinkedHover();
  const blocks = createLinkedHover();
  const blockOf: Record<string, string> = { p1: "b1" };
  const rows = deriveLinkedHover(
    [places, blocks],
    () => {
      const p = places.get();
      return blocks.get() ?? (p === null ? null : (blockOf[p] ?? null));
    },
    blocks.report,
  );
  let calls = 0;
  const off = rows.subscribe(() => calls++);
  places.report("p1", true);
  expect(rows.get()).toBe("b1");
  rows.report("b2", true);
  expect(blocks.get()).toBe("b2");
  expect(rows.get()).toBe("b2");
  expect(calls).toBe(2);
  off();
});
