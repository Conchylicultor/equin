import { runtimePath } from "@plugins/infra/plugins/launcher/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agentPolicySettings,
  bunScriptHookCommand,
  GUARD_SCRIPTS,
} from "./agent-policy";

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

describe("bunScriptHookCommand", () => {
  // The PATH an agent pane runs with — mise's shims first: from a dir with no
  // mise.toml, a bare `bun` there fails "No version is set for shim: bun".
  const path = runtimePath(process.env);
  const script = join(repoRoot, GUARD_SCRIPTS.stop);

  test("runs the script from its own directory", () => {
    expect(bunScriptHookCommand(script)).toBe(
      `cd "${dirname(script)}" && bun "${script}"`,
    );
  });

  test("runs from a workspace outside any checkout, bun resolved by mise", () => {
    inScratch((scratch) => {
      const result = Bun.spawnSync(
        ["/bin/sh", "-c", bunScriptHookCommand(script)],
        {
          cwd: scratch,
          env: { ...process.env, PATH: path },
          stdin: new TextEncoder().encode("{}"),
        },
      );
      expect(result.stderr.toString()).not.toContain("mise ERROR");
      expect(result.exitCode).toBe(0);
    });
  });

  test("refuses a path it cannot splice into a shell command", () => {
    expect(() => bunScriptHookCommand("relative/x.ts")).toThrow();
    expect(() => bunScriptHookCommand('/a/"; rm -rf ~ #.ts')).toThrow();
  });
});
