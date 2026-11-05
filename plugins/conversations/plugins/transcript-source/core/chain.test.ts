import { describe, expect, test } from "bun:test";
import { transcriptChainOf } from "./chain";

const s = (claudeSessionId: string) => ({ claudeSessionId });

describe("transcriptChainOf", () => {
  test("a recorded chain is the whole truth, oldest → newest", () => {
    expect(
      transcriptChainOf([s("a"), s("b")], { claudeSessionId: "c" }, "/w"),
    ).toEqual({ sessionIds: ["a", "b"], cwd: "/w" });
  });

  test("an empty chain falls back to the tail", () => {
    expect(transcriptChainOf([], { claudeSessionId: "t" }, "/w")).toEqual({
      sessionIds: ["t"],
      cwd: "/w",
    });
  });

  test("no session yet, or no such conversation, is an empty chain", () => {
    expect(transcriptChainOf([], { claudeSessionId: null }, "/w")).toEqual({
      sessionIds: [],
      cwd: "/w",
    });
    expect(transcriptChainOf([], undefined, undefined)).toEqual({
      sessionIds: [],
      cwd: null,
    });
  });

  test("no working directory yet is a null cwd", () => {
    expect(transcriptChainOf([s("a")], undefined, "")).toEqual({
      sessionIds: ["a"],
      cwd: null,
    });
  });
});
