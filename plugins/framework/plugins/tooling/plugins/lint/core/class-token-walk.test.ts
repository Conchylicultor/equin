import { describe, expect, test } from "bun:test";
import { baseClass, ownClass } from "./class-token-walk";

describe("ownClass", () => {
  test("a bare utility is the element's own", () => {
    expect(ownClass("h-7")).toBe("h-7");
    expect(ownClass("-inset-1")).toBe("inset-1");
  });

  test("a condition on the element keeps the utility on its box", () => {
    for (const t of [
      "hover:rounded-md",
      "md:h-7",
      "dark:hover:px-2",
      "data-[state=open]:rounded-full",
      "group-hover:h-6",
      "aria-[orientation=horizontal]:h-px",
      "[&:hover]:rounded-md",
      "[&[aria-pressed=true]]:px-2",
      "[.dark_&]:h-7",
      "[[data-soft-row]+&]:rounded",
    ]) {
      expect(ownClass(t)).toBe(baseClass(t));
    }
  });

  test("a pseudo-element or descendant variant retargets the utility", () => {
    for (const t of [
      "after:h-0.5",
      "after:rounded-full",
      "before:px-2",
      "hover:after:h-1",
      "aria-[orientation=horizontal]:after:h-1",
      "placeholder:px-2",
      "*:rounded",
      "**:h-4",
      "[&>svg]:size-4",
      "[&_svg]:size-4",
      "[&::after]:h-1",
      "[&+div]:rounded",
    ]) {
      expect(ownClass(t)).toBeUndefined();
    }
  });
});
