import { describe, expect, test } from "bun:test";
import { runGuardWithFallback, withNotice, type Fallback } from "./bootstrap";

const DENY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "no",
  },
});

function fallback(run: Fallback["run"]): () => Promise<Fallback> {
  return async () => ({ liveRoot: "/wt", mainRoot: "/main", run });
}

const broken = async (): Promise<string> => {
  throw new SyntaxError("Export named 'RESERVED_VIEW_PARAM' not found");
};

describe("runGuardWithFallback", () => {
  test("a live guard that runs is the verdict, main never asked", async () => {
    let asked = false;
    const result = await runGuardWithFallback({
      live: async () => DENY,
      fallback: async () => {
        asked = true;
        return null;
      },
    });
    expect(result).toEqual({ ok: true, stdout: DENY });
    expect(asked).toBe(false);
  });

  test("a live guard that throws gets main's verdict, with the error on it", async () => {
    const result = await runGuardWithFallback({
      live: broken,
      fallback: fallback(async () => ({ ok: true, stdout: DENY })),
    });
    if (!result.ok) throw new Error(result.stderr);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toStartWith(
      "no\n\n",
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "RESERVED_VIEW_PARAM",
    );
  });

  test("main's silent allow still carries the notice", async () => {
    const result = await runGuardWithFallback({
      live: broken,
      fallback: fallback(async () => ({ ok: true, stdout: "" })),
    });
    if (!result.ok) throw new Error(result.stderr);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "main's guards (/main) judged this call",
    );
  });

  test("never fails open: no fallback, or a failing one, is a failure", async () => {
    const none = await runGuardWithFallback({
      live: broken,
      fallback: async () => null,
    });
    expect(none.ok).toBe(false);
    const failing = await runGuardWithFallback({
      live: broken,
      fallback: fallback(async () => ({ ok: false, error: "exit 1" })),
    });
    expect(failing.ok).toBe(false);
    if (!failing.ok) {
      expect(failing.stderr).toContain("RESERVED_VIEW_PARAM");
      expect(failing.stderr).toContain("exit 1");
    }
  });

  test("main's output that is not a hook output object is a failure, not an allow", async () => {
    const result = await runGuardWithFallback({
      live: broken,
      fallback: fallback(async () => ({ ok: true, stdout: "[]" })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stderr).toContain("not a hook output object");
  });
});

describe("withNotice", () => {
  test("appends to an existing additional context, keeping a rewrite", () => {
    const out = JSON.parse(
      withNotice(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { command: "x" },
            additionalContext: "fact",
          },
        }),
        "note",
      ),
    );
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: { command: "x" },
      additionalContext: "fact\n\nnote",
    });
  });
});
