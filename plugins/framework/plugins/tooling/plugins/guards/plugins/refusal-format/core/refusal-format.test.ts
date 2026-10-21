import { describe, expect, test } from "bun:test";
import { joinRefusal, REFUSAL_HEADER, refusalReason } from "./refusal-format";

describe("refusalReason", () => {
  test("reads back the reason joinRefusal wrote", () => {
    const text = joinRefusal(
      `${REFUSAL_HEADER}\nNothing ran.`,
      "a wait loop\n\nEnd your turn.",
    );
    expect(refusalReason(text)).toBe("a wait loop\n\nEnd your turn.");
  });

  test("is undefined for text that is not a guard denial", () => {
    expect(refusalReason("Why it was blocked:\nx")).toBeUndefined();
    expect(refusalReason(`${REFUSAL_HEADER} no reason`)).toBeUndefined();
  });
});
