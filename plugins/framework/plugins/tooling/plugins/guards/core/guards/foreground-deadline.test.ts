import { describe, expect, test } from "bun:test";
import { envNames } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { createContext } from "../context";
import type { BashInput, Verdict } from "../types";
import {
  MAX_FOREGROUND_TIMEOUT_MS,
  foregroundDeadlineGuard,
} from "./foreground-deadline";

function patch(input: BashInput) {
  const v = foregroundDeadlineGuard.check(
    input,
    createContext("/tmp"),
  ) as Verdict;
  return v.kind === "rewrite" ? v.patch : undefined;
}

const EXPORT_RE = new RegExp(
  `^export ${envNames("FOREGROUND_DEADLINE")
    .map((name) => `${name}=(\\d+)`)
    .join(" ")}; `,
);

describe("foreground-deadline guard", () => {
  test("a foreground check gets the deadline exported and the full limit", () => {
    const before = Date.now();
    const p = patch({ command: "./equin check type-check", timeout: 120_000 });
    expect(p?.timeout).toBe(MAX_FOREGROUND_TIMEOUT_MS);
    const m = String(p?.command).match(EXPORT_RE);
    expect(m).not.toBeNull();
    const deadline = Number(m![1]);
    // Inside the call's window, short of its limit.
    expect(deadline).toBeGreaterThan(before);
    expect(deadline).toBeLessThan(before + MAX_FOREGROUND_TIMEOUT_MS);
    expect(String(p?.command)).toEndWith("; ./equin check type-check");
  });

  test("a chain reaches every op in it", () => {
    expect(
      String(patch({ command: "cd x && ./equin test plugins/a" })?.command),
    ).toMatch(EXPORT_RE);
  });

  test("background calls, other ops and instant flags are untouched", () => {
    expect(
      patch({ command: "./equin test", run_in_background: true }),
    ).toBeUndefined();
    expect(patch({ command: "./equin format" })).toBeUndefined();
    expect(patch({ command: "./equin check --list" })).toBeUndefined();
    expect(patch({ command: "ls" })).toBeUndefined();
  });
});
