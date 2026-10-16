import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  AGENT_SESSION_ENV_ALLOWLIST,
  AGENT_SESSION_PATH_SEED,
  AGENT_SESSION_WRAPPER,
} from "./agent-session-env";

// The namespace variable the tmux server used to leak into every pane. Spelled
// from its parts so the identifier itself stays out of the tree: the rule that
// bans it does not need an exception for the test that proves it is gone.
const LEAKED_NAMESPACE_VAR = ["SINGULARITY", "WORKTREE"].join("_");

// Every `NAME=` word the wrapper hands to `env -i`, in order.
function assignedNames(wrapper: string): string[] {
  const body = wrapper.slice(
    wrapper.indexOf("env -i ") + "env -i ".length,
    wrapper.indexOf(" zsh -l -c"),
  );
  return body.split(" ").map((word) => word.slice(0, word.indexOf("=")));
}

describe("the agent-session wrapper", () => {
  test("starts the inner shell from an empty environment", () => {
    expect(AGENT_SESSION_WRAPPER).toContain("env -i ");
    expect(AGENT_SESSION_WRAPPER).toContain(`PATH=${AGENT_SESSION_PATH_SEED}`);
  });

  test("forwards every allowlisted name by value", () => {
    for (const name of AGENT_SESSION_ENV_ALLOWLIST) {
      expect(AGENT_SESSION_WRAPPER).toContain(`${name}="$${name}"`);
    }
  });

  test("passes nothing the allowlist does not name", () => {
    // A closed-set assertion, not a list of known-bad names: a denylist would
    // only ever catch the last leak somebody found.
    expect(assignedNames(AGENT_SESSION_WRAPPER)).toEqual([
      ...AGENT_SESSION_ENV_ALLOWLIST,
      "PATH",
    ]);
    expect(AGENT_SESSION_WRAPPER).not.toContain(LEAKED_NAMESPACE_VAR);
    expect(AGENT_SESSION_WRAPPER).not.toContain("SOCKET_PATH");
  });

  test("keeps the pane-ownership stamp", () => {
    // Tier-1 pane ownership matches a session file's tmux stamp against the
    // pane id, which the CLI can only write if it inherits it.
    expect(AGENT_SESSION_ENV_ALLOWLIST).toContain("TMUX_PANE");
  });

  test("interpolates nothing, so a command needs no escaping", () => {
    // The shims, the command and the prompt all ride as positional words.
    expect(AGENT_SESSION_WRAPPER).toContain('zsh "$shims" "$cmd" "$@"');
    expect(AGENT_SESSION_WRAPPER).toContain('eval "$cmd"');
  });
});

// Drives the real shells with the exact argv shape tmux execs, minus tmux:
// `zsh -l -c <wrapper> zsh <shimsDir> <claudeCmd> [prompt]`, under an
// environment that carries the leak.
async function runWrapper(
  claudeCmd: string,
  prompt?: string,
  shims = "/fixture/mise/shims",
) {
  // Every value is a fixture. The question this test asks is which KEYS come
  // out the far side, so none of them needs to name anything real — and the
  // inner login shell reads the system profile either way.
  const env = {
    HOME: "/fixture/home",
    USER: "fixture-user",
    LOGNAME: "fixture-user",
    SHELL: "/bin/zsh",
    TERM: "tmux-256color",
    LANG: "C.UTF-8",
    // What tmux injects when it forks the pane.
    TMUX: "/fixture/tmux-socket,1,0",
    TMUX_PANE: "%99",
    // What the runtime delivers with `-e`.
    SINGULARITY_CONVERSATION_ID: "conv-test",
    SINGULARITY_PARENT_HOST: "att-test-w6l1",
    CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
    // What the tmux server carried in from whoever started it.
    [LEAKED_NAMESPACE_VAR]: "fixture-namespace",
    SOCKET_PATH: "/fixture/backend.sock",
    ZZ_ENVTEST_PROBE: "leaked",
  };
  return await spawnCaptured(
    [
      "/bin/zsh",
      "-l",
      "-c",
      AGENT_SESSION_WRAPPER,
      "zsh",
      shims,
      claudeCmd,
      ...(prompt === undefined ? [] : [prompt]),
    ],
    { env, timeoutMs: 30_000, mergeStderr: true },
  );
}

// `--settings '{"ultracode":true}'` is the real command's single-quoted part;
// echoing it back proves the quoting survived two shells.
const SETTINGS = '{"ultracode":true}';
const PROBE_CMD = [
  `printf 'SETTINGS<%s>\\n' '${SETTINGS}'`,
  `printf 'PROMPT<%s>\\n' "$1"`,
  "env",
].join("; ");

describe("the wrapper, executed", () => {
  test("delivers the command and the prompt, and drops the leak", async () => {
    const prompt = "fix the 'quoting' bug\nin $HOME/notes & elsewhere";
    const res = await runWrapper(PROBE_CMD, prompt);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`SETTINGS<${SETTINGS}>`);
    expect(res.stdout).toContain(`PROMPT<${prompt}>`);

    // The pane keeps what it was given...
    expect(res.stdout).toContain("TMUX_PANE=%99");
    expect(res.stdout).toContain("SINGULARITY_CONVERSATION_ID=conv-test");
    expect(res.stdout).toContain("SINGULARITY_PARENT_HOST=att-test-w6l1");
    // ...and nothing it was not.
    expect(res.stdout).not.toContain(LEAKED_NAMESPACE_VAR);
    expect(res.stdout).not.toContain("SOCKET_PATH=");
    expect(res.stdout).not.toContain("ZZ_ENVTEST_PROBE");
  });

  test("puts the shims first, so the pane finds mise's bun", async () => {
    // A login shell that is not interactive never reads ~/.zshrc, where
    // `mise activate` lives: the pane must find `bun` without it.
    const shims = mkdtempSync(join(tmpdir(), "agent-session-shims-"));
    try {
      const bun = join(shims, "bun");
      writeFileSync(bun, "#!/bin/sh\nexit 0\n");
      chmodSync(bun, 0o755);
      const res = await runWrapper(
        'printf "PATH<%s>\\nBUN<%s>\\n" "$PATH" "$(command -v bun)"',
        undefined,
        shims,
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(`PATH<${shims}:`);
      expect(res.stdout).toContain(`BUN<${bun}>`);
    } finally {
      rmSync(shims, { recursive: true, force: true });
    }
  });

  test("runs with no prompt at all", async () => {
    const res = await runWrapper('printf "NARGS<%d>\\n" $#');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("NARGS<0>");
  });
});
