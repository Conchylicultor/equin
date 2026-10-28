import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAMP_REL } from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import {
  assertCheckoutInstalled,
  CheckoutNotInstalledError,
  INSTALL_STAMP_REL,
  runGuardWithFallback,
  withNotice,
  type Fallback,
} from "./bootstrap";

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

describe("assertCheckoutInstalled", () => {
  let base = "";
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  // A checkout with a `.git` file (a linked worktree) and the guard's own path.
  function checkout(): { root: string; script: string } {
    base = realpathSync(mkdtempSync(join(tmpdir(), "guard-install-")));
    const root = join(base, "wt");
    const bin = join(root, "plugins", "guards", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: /nowhere\n");
    return { root, script: join(bin, "guard.ts") };
  }

  test("the stamp it looks for is the one ensureDeps writes", () => {
    expect(INSTALL_STAMP_REL).toBe(STAMP_REL);
  });

  test("no stamp is a named failure, so main's guard runs with the reason", async () => {
    const { root, script } = checkout();
    expect(() => assertCheckoutInstalled(script)).toThrow(
      CheckoutNotInstalledError,
    );
    const result = await runGuardWithFallback({
      live: async () => {
        assertCheckoutInstalled(script);
        return DENY;
      },
      fallback: fallback(async () => ({ ok: true, stdout: "" })),
    });
    if (!result.ok) throw new Error(result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext as string;
    expect(context).toContain(
      `this checkout is not installed (no ${STAMP_REL} in ${root})`,
    );
    expect(context).not.toContain("at assertCheckoutInstalled");
  });

  test("a stamped checkout passes", () => {
    const { root, script } = checkout();
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, STAMP_REL), "{}");
    expect(() => assertCheckoutInstalled(script)).not.toThrow();
  });
});
