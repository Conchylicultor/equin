import { describe, expect, test } from "bun:test";
import { jsonResponse, parseUrl, promiseWithResolvers } from "./compat";

describe("floor-safe spellings answer as the built-ins do", () => {
  test("parseUrl ≡ URL.parse", () => {
    for (const [raw, base] of [
      ["https://equin.ai/a", undefined],
      ["/a", "https://equin.ai"],
      ["nope", undefined],
    ] as const)
      expect(parseUrl(raw, base)?.href).toBe(URL.parse(raw, base)?.href);
  });

  test("jsonResponse ≡ Response.json", async () => {
    const init = { status: 418, headers: { "x-a": "b" } };
    const ours = jsonResponse({ a: [1] }, init);
    const theirs = Response.json({ a: [1] }, init);
    expect(ours.status).toBe(theirs.status);
    expect([...ours.headers]).toEqual([...theirs.headers]);
    expect(await ours.text()).toBe(await theirs.text());
  });

  test("jsonResponse keeps a content-type the caller set", () => {
    const res = jsonResponse(1, {
      headers: { "Content-Type": "application/problem+json" },
    });
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  test("promiseWithResolvers settles its promise", async () => {
    const ok = promiseWithResolvers<number>();
    ok.resolve(3);
    expect(await ok.promise).toBe(3);
    const ko = promiseWithResolvers<number>();
    ko.reject(new Error("x"));
    expect(ko.promise).rejects.toThrow("x");
  });
});
