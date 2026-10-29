import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { BROWSER_RECENTS_LIMIT } from "./resources";
import { postBrowserHistory } from "./endpoints";

function apply(url: string, recents: readonly unknown[]) {
  const [t] = readLiveEffect(postBrowserHistory.effect).resolve({
    params: {},
    body: { url },
  }).targets;
  if (t === undefined || t.kind !== "value") throw new Error("value target");
  return t.apply(recents) as { url: string; title: string }[];
}

const at = (url: string) => ({ url, title: url, visitedAt: new Date(0) });

describe("postBrowserHistory effect", () => {
  test("a visit goes to the top, titled by its hostname", () => {
    const next = apply("https://a.example/x", [at("b")]);
    expect(next.map((r) => r.url)).toEqual(["https://a.example/x", "b"]);
    expect(next[0]?.title).toBe("a.example");
  });

  test("a repeated url is one row, moved to the top", () => {
    expect(apply("b", [at("a"), at("b")]).map((r) => r.url)).toEqual([
      "b",
      "a",
    ]);
  });

  test("the list stays capped", () => {
    const full = Array.from({ length: BROWSER_RECENTS_LIMIT }, (_, i) =>
      at(`u${i}`),
    );
    expect(apply("new", full)).toHaveLength(BROWSER_RECENTS_LIMIT);
  });
});
