import { describe, expect, test } from "bun:test";
import { rateDecision } from "./rate-limit";

const NOW = new Date("2026-10-24T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe("rateDecision", () => {
  test("a first message, and a third within ten minutes, pass", () => {
    expect(rateDecision([], NOW)).toEqual({ ok: true });
    expect(rateDecision([ago(1), ago(2)], NOW)).toEqual({ ok: true });
  });

  test("a fourth within ten minutes waits until the oldest leaves the window", () => {
    expect(rateDecision([ago(1), ago(2), ago(8)], NOW)).toEqual({
      ok: false,
      retryAfterS: 2 * 60,
    });
  });

  test("messages older than ten minutes no longer count toward the short window", () => {
    expect(rateDecision([ago(11), ago(12), ago(13)], NOW)).toEqual({
      ok: true,
    });
  });

  test("an eleventh within a day waits until the oldest is a day old", () => {
    const tenSpread = Array.from({ length: 10 }, (_, i) => ago(60 + i * 60));
    // Oldest is 600 min ago: 24h − 10h = 14h to wait.
    expect(rateDecision(tenSpread, NOW)).toEqual({
      ok: false,
      retryAfterS: 14 * 60 * 60,
    });
  });

  test("the longest wait across full windows wins", () => {
    const prior = [
      ago(1),
      ago(2),
      ago(3),
      ...Array.from({ length: 7 }, (_, i) => ago(100 + i)),
    ];
    const decision = rateDecision(prior, NOW);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      // The day window frees when the 106-min-old message turns a day old.
      expect(decision.retryAfterS).toBe((24 * 60 - 106) * 60);
    }
  });

  test("a wait under a second still says one second", () => {
    const prior = [new Date(NOW.getTime() - 10 * 60_000 + 200), ago(1), ago(2)];
    expect(rateDecision(prior, NOW)).toEqual({ ok: false, retryAfterS: 1 });
  });
});
