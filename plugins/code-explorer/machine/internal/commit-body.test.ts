import { describe, expect, test } from "bun:test";
import { bodyWithoutTrailers } from "./commit-body";

describe("bodyWithoutTrailers", () => {
  test("drops the last paragraph when git parsed trailers", () => {
    const raw =
      "First paragraph.\n\n- a\n- b\n\nReviewed-By: R <r@x>\nCo-Authored-By: C <c@x>\n";
    expect(bodyWithoutTrailers(raw, 2)).toBe("First paragraph.\n\n- a\n- b");
  });

  test("a body that is only trailers is empty", () => {
    expect(bodyWithoutTrailers("Reviewed-By: R <r@x>\n", 1)).toBe("");
  });

  test("no trailers keeps everything", () => {
    expect(bodyWithoutTrailers("\nA.\n\nB: not a trailer here\n\n", 0)).toBe(
      "A.\n\nB: not a trailer here",
    );
  });

  test("empty body", () => {
    expect(bodyWithoutTrailers("", 0)).toBe("");
  });

  test("blank lines holding spaces still separate paragraphs", () => {
    expect(bodyWithoutTrailers("A.\n  \nKey: v", 1)).toBe("A.");
  });
});
