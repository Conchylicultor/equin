import { describe, expect, test } from "bun:test";
import { graphEtag } from "./etag";

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAIN_A = "1111111111111111111111111111111111111111";
const MAIN_B = "2222222222222222222222222222222222222222";

describe("graphEtag", () => {
  test("identical inputs ⇒ identical string", () => {
    expect(graphEtag(HEAD_A, MAIN_A)).toBe(graphEtag(HEAD_A, MAIN_A));
  });

  test("a changed headSha ⇒ a different string", () => {
    expect(graphEtag(HEAD_A, MAIN_A)).not.toBe(graphEtag(HEAD_B, MAIN_A));
  });

  // A commit joins the landed set only by landing on `main`, so `mainSha` is the
  // dimension that covers it — there is no separate landed-shas argument to vary.
  test("a changed mainSha ⇒ a different string", () => {
    expect(graphEtag(HEAD_A, MAIN_A)).not.toBe(graphEtag(HEAD_A, MAIN_B));
  });

  test("head/main are not conflated (order matters)", () => {
    expect(graphEtag(HEAD_A, MAIN_A)).not.toBe(graphEtag(MAIN_A, HEAD_A));
  });
});
