import { expect, test } from "bun:test";
import { nextLinkedHover } from "./linked-hover";

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
