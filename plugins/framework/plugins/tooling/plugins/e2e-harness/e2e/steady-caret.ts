/**
 * A non-blinking text caret for the browser this run launches — macOS's own
 * "non-blinking cursor" setting (`NSTextInsertionPointBlinkPeriodOn/Off`),
 * which Chromium reads for its caret blink interval.
 *
 * Why a script wants it: a blinking caret runs on the browser's real clock,
 * so a run that captures frames slower than real time (media/film's virtual
 * clock) catches the caret in a random phase on every frame — a flicker no
 * user ever saw. A steady caret is a real setting a user can have, so the
 * frames stay truthful.
 *
 * Chromium reads the setting from the `chrome-headless-shell` preferences
 * domain (the binary's own, not the global one). It is written just before
 * the launch and the previous values put back when the run ends, so nothing
 * outlives the run but a launch that was killed (then the next run's restore
 * re-reads the same domain: the values this writes are recognisable and
 * removed).
 */
import { spawnSync } from "node:child_process";

const DOMAIN = "chrome-headless-shell";
const KEYS = {
  NSTextInsertionPointBlinkPeriodOn: "100000000",
  NSTextInsertionPointBlinkPeriodOff: "1",
} as const;

function defaults(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("defaults", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

/** Run `fn` with the headless shell's caret steady; restore the domain after. */
export async function withSteadyCaret<T>(fn: () => Promise<T>): Promise<T> {
  if (process.platform !== "darwin")
    throw new Error(
      "steadyCaret: the non-blinking caret is macOS's preference; this run is not on macOS",
    );
  const before = Object.fromEntries(
    Object.keys(KEYS).map((k) => {
      const r = defaults("read", DOMAIN, k);
      // A value this module wrote (a killed run's) is not the user's.
      const ours =
        r.ok && Object.values(KEYS).some((v) => Number(r.out) === Number(v));
      return [k, r.ok && !ours ? r.out : null];
    }),
  ) as Record<keyof typeof KEYS, string | null>;
  for (const [k, v] of Object.entries(KEYS)) {
    const w = defaults("write", DOMAIN, k, "-float", v);
    if (!w.ok)
      throw new Error(`steadyCaret: defaults write ${DOMAIN} ${k} failed`);
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
      const prev = before[k];
      if (prev === null) defaults("delete", DOMAIN, k);
      else defaults("write", DOMAIN, k, "-float", prev);
    }
  }
}
