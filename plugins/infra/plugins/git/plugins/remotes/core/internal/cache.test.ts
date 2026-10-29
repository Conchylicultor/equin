import { describe, expect, test } from "bun:test";
import { cacheDecision, NO_PUBLISH } from "./cache";

const URL = "https://github.com/Conchylicultor/equin.git";

describe("cacheDecision", () => {
  test("nothing recorded means probe", () => {
    expect(cacheDecision({ remote: null, url: null }, "origin", URL)).toEqual({
      kind: "stale",
    });
  });

  test("half a record means probe", () => {
    expect(
      cacheDecision({ remote: "origin", url: null }, "origin", URL),
    ).toEqual({ kind: "stale" });
    expect(cacheDecision({ remote: null, url: URL }, "origin", URL)).toEqual({
      kind: "stale",
    });
  });

  test("a recorded write is a hit", () => {
    expect(
      cacheDecision({ remote: "origin", url: URL }, "origin", URL),
    ).toEqual({
      kind: "hit",
      target: { kind: "publish", remote: "origin", url: URL },
    });
  });

  test("a recorded refusal is a hit, and says why", () => {
    const decision = cacheDecision(
      { remote: NO_PUBLISH, url: URL },
      "origin",
      URL,
    );
    expect(decision.kind).toBe("hit");
    expect(decision).toHaveProperty("target.kind", "local");
    expect(decision).toHaveProperty("target.reason.kind", "read-only");
  });

  // Re-pointing origin changes how we authenticate to it, which is the input to
  // the answer that was recorded — so the recorded answer is about a different
  // remote than the one in front of us.
  test("a moved URL means probe, even for the same repository", () => {
    expect(
      cacheDecision(
        { remote: "origin", url: URL },
        "origin",
        "git@github.com:Conchylicultor/equin.git",
      ),
    ).toEqual({ kind: "stale" });
  });

  test("an answer about a different remote is not an answer about this one", () => {
    expect(cacheDecision({ remote: "fork", url: URL }, "origin", URL)).toEqual({
      kind: "stale",
    });
  });
});
