import { expect, test } from "bun:test";
import { createTtlMemo } from "./details-cache";

test("reuses an answer within its TTL, re-fetches after it", async () => {
  let t = 0;
  const memo = createTtlMemo<number>(1000, () => t);
  let calls = 0;
  const fetch = async () => ++calls;
  expect(await memo.get("a", fetch)).toBe(1);
  t = 999;
  expect(await memo.get("a", fetch)).toBe(1);
  t = 1000;
  expect(await memo.get("a", fetch)).toBe(2);
  expect(await memo.get("b", fetch)).toBe(3);
});

test("concurrent misses share one fetch", async () => {
  const memo = createTtlMemo<string>(1000);
  let calls = 0;
  const fetch = async () => {
    calls++;
    await Promise.resolve();
    return "v";
  };
  expect(
    await Promise.all([memo.get("k", fetch), memo.get("k", fetch)]),
  ).toEqual(["v", "v"]);
  expect(calls).toBe(1);
});

test("a failed fetch is not kept", async () => {
  const memo = createTtlMemo<string>(1000);
  let failed: unknown;
  try {
    await memo.get("k", () => Promise.reject(new Error("boom")));
  } catch (err) {
    failed = err;
  }
  expect(failed).toBeInstanceOf(Error);
  expect(await memo.get("k", async () => "ok")).toBe("ok");
});
