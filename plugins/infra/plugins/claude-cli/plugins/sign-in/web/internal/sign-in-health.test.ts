import { describe, expect, test } from "bun:test";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { ClaudeSignInFlow } from "../../core";
import { signInHealth } from "./sign-in-health";

const signedOut: HealthStatus = {
  state: "critical",
  summary: "Claude Code is not signed in — agents cannot start",
};
const computer = { kind: "computer", method: "claudeai" } as const;

describe("signInHealth", () => {
  test("a computer sign-in under way pulses, signing in", () => {
    const flow: ClaudeSignInFlow = {
      kind: "waiting",
      id: "1",
      target: computer,
      url: null,
      manualUrl: null,
    };
    expect(signInHealth(signedOut, flow)).toEqual({
      state: "attention",
      summary: "Signing in…",
      transitioning: true,
    });
  });

  test("a failed one stays critical and says so", () => {
    const flow: ClaudeSignInFlow = {
      kind: "failed",
      id: "1",
      target: computer,
      error: "closed",
    };
    expect(signInHealth(signedOut, flow)).toEqual({
      state: "critical",
      summary: "Sign-in didn't finish — agents can't start",
    });
  });

  test("leaves every other verdict alone", () => {
    const waiting: ClaudeSignInFlow = {
      kind: "waiting",
      id: "1",
      target: computer,
      url: null,
      manualUrl: null,
    };
    const ok: HealthStatus = { state: "ok", summary: "v2" };
    expect(signInHealth(ok, waiting)).toBe(ok);
    expect(signInHealth({ state: "unknown" }, waiting)).toEqual({
      state: "unknown",
    });
    expect(signInHealth(signedOut, null)).toBe(signedOut);
    expect(signInHealth(signedOut, { kind: "idle" })).toBe(signedOut);
    expect(
      signInHealth(signedOut, {
        kind: "waiting",
        id: "2",
        target: { kind: "new-account", name: "Work" },
        url: null,
        manualUrl: null,
      }),
    ).toBe(signedOut);
  });
});
