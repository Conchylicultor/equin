import { describe, expect, test } from "bun:test";
import { transcriptChainOf } from "./chain";

const s = (claudeSessionId: string) => ({ claudeSessionId });

describe("transcriptChainOf", () => {
  test("a recorded chain is the whole truth, oldest → newest", () => {
    expect(
      transcriptChainOf([s("a"), s("b")], { claudeSessionId: "c" }),
    ).toEqual({ sessionIds: ["a", "b"] });
  });

  test("an empty chain falls back to the tail", () => {
    expect(transcriptChainOf([], { claudeSessionId: "t" })).toEqual({
      sessionIds: ["t"],
    });
  });

  test("no session yet, or no such conversation, is an empty chain", () => {
    expect(transcriptChainOf([], { claudeSessionId: null })).toEqual({
      sessionIds: [],
    });
    expect(transcriptChainOf([], undefined)).toEqual({ sessionIds: [] });
  });
});
