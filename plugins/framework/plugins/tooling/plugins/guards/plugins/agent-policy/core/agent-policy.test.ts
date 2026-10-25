import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPolicySettings } from "./agent-policy";

const repoRoot = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
  cwd: import.meta.dir,
})
  .stdout.toString()
  .trim();

function preToolUseCommand(): string {
  const command =
    agentPolicySettings().hooks.PreToolUse?.[0]?.hooks[0]?.command;
  if (!command) throw new Error("no PreToolUse hook");
  return command;
}

/** Runs the hook the way Claude Code does: from the agent's `cwd`, the guards rooted at `guardsRoot`. */
function runHook(cwd: string, guardsRoot: string) {
  const result = Bun.spawnSync(["/bin/sh", "-c", preToolUseCommand()], {
    cwd,
    env: { ...process.env, ...envEntries({ GUARDS_ROOT: guardsRoot }) },
    stdin: new TextEncoder().encode(
      JSON.stringify({ tool_name: "Read", tool_input: {} }),
    ),
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

function inScratch(fn: (scratch: string) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), "agent-policy-scratch-"));
  try {
    fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true });
  }
}

describe("PreToolUse hook", () => {
  test("runs from a workspace outside any checkout (no mise.toml there to pick bun's version)", () => {
    inScratch((scratch) => {
      expect(runHook(scratch, repoRoot)).toEqual({ exitCode: 0, stderr: "" });
    });
  });

  test("blocks (exit 2) when the guard cannot run, never letting the call through", () => {
    inScratch((scratch) => {
      const { exitCode, stderr } = runHook(
        scratch,
        join(scratch, "no-such-checkout"),
      );
      expect(exitCode).toBe(2);
      expect(stderr).toContain("every tool call is blocked");
    });
  });
});
