import { runtimePath } from "@plugins/infra/plugins/launcher/plugins/runtime-env/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agentPolicySettings,
  GUARD_SCRIPTS,
  HOOK_LAUNCHER,
  hookCommand,
  isLauncherHookCommand,
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
function runHook(
  cwd: string,
  guardsRoot: string,
  env: Record<string, string | undefined> = process.env,
) {
  const result = Bun.spawnSync(["/bin/sh", "-c", preToolUseCommand()], {
    cwd,
    env: { ...env, ...envEntries({ GUARDS_ROOT: guardsRoot }) },
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

  test("blocks (exit 2) and names the fix when no bun can be found", () => {
    inScratch((scratch) => {
      const { exitCode, stderr } = runHook(
        scratch,
        repoRoot,
        noBunEnv(scratch),
      );
      expect(exitCode).toBe(2);
      expect(stderr).toContain("bun is not on PATH and mise has no bun shim");
      expect(stderr).toContain("mise activate");
      expect(stderr).toContain("every tool call is blocked");
    });
  });
});

/** An environment with no bun anywhere: system PATH only, mise's data dir empty. */
function noBunEnv(scratch: string): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: "/usr/bin:/bin",
    HOME: scratch,
    MISE_DATA_DIR: join(scratch, "mise"),
  };
}

describe("every hook command", () => {
  test("runs through the launcher by absolute path, never a bare bun", () => {
    for (const groups of Object.values(agentPolicySettings().hooks))
      for (const group of groups)
        for (const hook of group.hooks) {
          expect(isLauncherHookCommand(hook.command)).toBe(true);
          expect(hook.command).not.toMatch(/(^|[;&|]\s*)bun\s/);
        }
  });
});

describe("hookCommand", () => {
  // The PATH an agent pane runs with — mise's shims first: from a dir with no
  // mise.toml, a bare `bun` there fails "No version is set for shim: bun".
  const path = runtimePath(process.env);
  const script = GUARD_SCRIPTS.stop;

  function run(
    command: string,
    cwd: string,
    env: Record<string, string | undefined>,
  ) {
    const result = Bun.spawnSync(["/bin/sh", "-c", command], {
      cwd,
      env,
      stdin: new TextEncoder().encode("{}"),
    });
    return { exitCode: result.exitCode, stderr: result.stderr.toString() };
  }

  test("runs the launcher over the script, both by absolute path", () => {
    const command = hookCommand({ checkout: repoRoot, script });
    expect<string>(command).toBe(
      `/bin/sh "${repoRoot}/${HOOK_LAUNCHER}" "${repoRoot}/${script}"`,
    );
    expect(isLauncherHookCommand(command)).toBe(true);
    expect(
      isLauncherHookCommand(`cd "${repoRoot}" && bun "${repoRoot}/${script}"`),
    ).toBe(false);
  });

  test("runs from a workspace outside any checkout, bun resolved by mise", () => {
    inScratch((scratch) => {
      const result = run(hookCommand({ checkout: repoRoot, script }), scratch, {
        ...process.env,
        PATH: path,
      });
      expect(result.stderr).not.toContain("mise ERROR");
      expect(result.exitCode).toBe(0);
    });
  });

  test("finds bun through mise's shims when it is not on PATH", () => {
    const shims = path.split(":")[0] ?? "";
    if (!shims.endsWith("/mise/shims"))
      throw new Error(`no mise shims on ${path}`);
    inScratch((scratch) => {
      const result = run(hookCommand({ checkout: repoRoot, script }), scratch, {
        ...process.env,
        PATH: "/usr/bin:/bin",
        MISE_DATA_DIR: dirname(shims),
      });
      expect(result.stderr).not.toContain("equin hook:");
      expect(result.exitCode).toBe(0);
    });
  });

  test("fails loudly, naming the fix, when there is no bun at all", () => {
    inScratch((scratch) => {
      const result = run(
        hookCommand({ checkout: repoRoot, script }),
        scratch,
        noBunEnv(scratch),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cannot run stop-guard.ts");
      expect(result.stderr).toContain("mise install");
    });
  });

  test("refuses a path it cannot splice into a shell command", () => {
    expect(() => hookCommand({ checkout: "relative", script })).toThrow();
    expect(() =>
      hookCommand({ checkout: repoRoot, script: "/abs/x.ts" }),
    ).toThrow();
    expect(() =>
      hookCommand({ checkout: '/a/"; rm -rf ~ #', script }),
    ).toThrow();
  });
});
