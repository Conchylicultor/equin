import { describe, expect, test } from "bun:test";
import { graphEtag } from "./etag";

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAIN_A = "1111111111111111111111111111111111111111";
const MAIN_B = "2222222222222222222222222222222222222222";
const WT = "/wt/a";

describe("graphEtag", () => {
  test("identical inputs ⇒ identical string", () => {
    expect(graphEtag(HEAD_A, MAIN_A, ["c1"], WT)).toBe(
      graphEtag(HEAD_A, MAIN_A, ["c1"], WT),
    );
  });

  test("a changed headSha ⇒ a different string", () => {
    expect(graphEtag(HEAD_A, MAIN_A, ["c1"], WT)).not.toBe(
      graphEtag(HEAD_B, MAIN_A, ["c1"], WT),
    );
  });

  // A commit landing on `main` moves the landed set and `mainSha` together.
  test("a changed mainSha ⇒ a different string", () => {
    expect(graphEtag(HEAD_A, MAIN_A, ["c1"], WT)).not.toBe(
      graphEtag(HEAD_A, MAIN_B, ["c1"], WT),
    );
  });

  // An adopted conversation can match commits already on `main`: the landed
  // set moves with no ref moving, so a stale 304 unless the set is folded in.
  test("a grown conversation set ⇒ a different string", () => {
    expect(graphEtag(HEAD_A, MAIN_A, ["c1"], WT)).not.toBe(
      graphEtag(HEAD_A, MAIN_A, ["c1", "c2"], WT),
    );
  });

  test("the conversation set is order-independent", () => {
    expect(graphEtag(HEAD_A, MAIN_A, ["c2", "c1"], WT)).toBe(
      graphEtag(HEAD_A, MAIN_A, ["c1", "c2"], WT),
    );
  });

  test("a re-pointed checkout ⇒ a different string", () => {
    expect(graphEtag(HEAD_A, MAIN_A, ["c1"], WT)).not.toBe(
      graphEtag(HEAD_A, MAIN_A, ["c1"], "/wt/b"),
    );
  });

  test("head/main are not conflated (order matters)", () => {
    expect(graphEtag(HEAD_A, MAIN_A, [], WT)).not.toBe(
      graphEtag(MAIN_A, HEAD_A, [], WT),
    );
  });
});
