import { expect, test } from "bun:test";
import { callModelTokens } from "./call-tokens";

const usage = (over: Record<string, number>) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 200_000,
  maxOutputTokens: 8_000,
  ...over,
});

test("splits cache creation by TTL; an unreported lifetime counts as 5m", () => {
  const [m] = callModelTokens({
    "model-b": usage({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 100,
      cacheCreationEphemeral5mInputTokens: 40,
      cacheCreationEphemeral1hInputTokens: 50,
    }),
  });
  expect(m).toEqual({
    model: "model-b",
    tokens: {
      input: { below: 10, above: 0 },
      output: { below: 20, above: 0 },
      cacheRead: { below: 30, above: 0 },
      cacheCreate5m: { below: 50, above: 0 },
      cacheCreate1h: { below: 50, above: 0 },
    },
  });
});

test("tiers each kind at 200k, cache creation on its combined count, in whole tokens", () => {
  const [m] = callModelTokens({
    "model-a": usage({
      inputTokens: 250_000,
      cacheCreationInputTokens: 300_001,
      cacheCreationEphemeral1hInputTokens: 100_000,
    }),
  });
  const t = m?.tokens;
  expect(t?.input).toEqual({ below: 200_000, above: 50_000 });
  const c5 = t?.cacheCreate5m;
  const c1 = t?.cacheCreate1h;
  // Conserved exactly, every count whole.
  expect((c5?.below ?? 0) + (c1?.below ?? 0)).toBe(200_000);
  expect((c5?.above ?? 0) + (c1?.above ?? 0)).toBe(100_001);
  expect((c5?.below ?? 0) + (c5?.above ?? 0)).toBe(200_001);
  for (const n of [c5?.below, c5?.above, c1?.below, c1?.above])
    expect(Number.isInteger(n)).toBe(true);
});

test("a model that used nothing is left out", () => {
  expect(callModelTokens({ "model-c": usage({}) })).toEqual([]);
});
