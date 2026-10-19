import { describe, expect, test } from "bun:test";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  AGENT_SESSION_DELIVERED_ENV,
  AGENT_SESSION_ENV_ALLOWLIST,
  AGENT_SESSION_PATH_SEED,
  AGENT_SESSION_WRAPPER,
  agentLoginShell,
  agentSessionArgs,
  agentSessionPath,
} from "./agent-session-env";

// The namespace variable the tmux server used to leak into every pane. Spelled
// from its parts so the identifier itself stays out of the tree: the rule that
// bans it does not need an exception for the test that proves it is gone.
const LEAKED_NAMESPACE_VAR = ["SINGULARITY", "WORKTREE"].join("_");

// Every `NAME=` word the wrapper hands to `env -i`, in order.
function assignedNames(wrapper: string): string[] {
  const body = wrapper.slice(
    wrapper.indexOf("env -i ") + "env -i ".length,
    wrapper.indexOf(' "$shell" -l -c'),
  );
  return body.split(" ").map((word) => word.slice(0, word.indexOf("=")));
}

describe("the agent-session wrapper", () => {
  test("starts the inner shell from an empty environment", () => {
    expect(AGENT_SESSION_WRAPPER).toContain("env -i ");
    expect(AGENT_SESSION_WRAPPER).toContain('PATH="$path"');
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
    expect(AGENT_SESSION_WRAPPER).toContain(
      '"$shell" -l -c "$cmd" "$shell" "$@"',
    );
    expect(AGENT_SESSION_WRAPPER).not.toContain("'");
  });
});

describe("agentSessionArgs", () => {
  const ENV = {
    SINGULARITY_CONVERSATION_ID: "conv-test",
    SINGULARITY_PARENT_HOST: "att-test-w6l1",
    CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
  };
  const args = agentSessionArgs({
    env: ENV,
    accountShell: "/fixture/bin/fish",
    claudeBin: "/opt/claude/claude",
    command: "claude --x",
    args: ["the prompt"],
  });

  test("delivers every allowlisted -e value, then the wrapper", () => {
    expect(args.slice(0, 6)).toEqual([
      "-e",
      "SINGULARITY_CONVERSATION_ID=conv-test",
      "-e",
      "SINGULARITY_PARENT_HOST=att-test-w6l1",
      "-e",
      "CLAUDE_CODE_DISABLE_AGENT_VIEW=1",
    ]);
    for (const name of AGENT_SESSION_DELIVERED_ENV) {
      expect(AGENT_SESSION_ENV_ALLOWLIST).toContain(name);
    }
    expect(args.slice(6, 11)).toEqual([
      "/bin/sh",
      "-c",
      AGENT_SESSION_WRAPPER,
      "sh",
      "/bin/sh",
    ]);
  });

  test("the PATH, then the command and its positional args", () => {
    expect(args[11]).toEndWith(`/opt/claude:${AGENT_SESSION_PATH_SEED}`);
    expect(args.slice(12)).toEqual(["claude --x", "the prompt"]);
  });
});

describe("the pane's PATH and shell", () => {
  test("the toolchain and claude come before the system seed", () => {
    expect(
      agentSessionPath({
        shimsDir: "/h/.local/share/mise/shims",
        claudeBin: "/h/.local/bin/claude",
      }),
    ).toBe(
      `/h/.local/share/mise/shims:/h/.local/bin:${AGENT_SESSION_PATH_SEED}`,
    );
  });

  test("a binary at the root keeps / as its directory", () => {
    expect(
      agentSessionPath({ shimsDir: undefined, claudeBin: "/claude" }),
    ).toBe(`/:${AGENT_SESSION_PATH_SEED}`);
  });

  test("no shims (a host without mise): claude's dir and the seed", () => {
    expect(
      agentSessionPath({
        shimsDir: undefined,
        claudeBin: "/opt/claude/claude",
      }),
    ).toBe(`/opt/claude:${AGENT_SESSION_PATH_SEED}`);
  });

  test("the account's own POSIX shell; anything else gets /bin/sh", () => {
    expect(agentLoginShell("/fixture/bin/zsh")).toBe("/fixture/bin/zsh");
    expect(agentLoginShell("/fixture/bin/bash")).toBe("/fixture/bin/bash");
    expect(agentLoginShell("/fixture/bin/fish")).toBe("/bin/sh");
  });
});

// Drives the real shells with the exact argv shape tmux execs, minus tmux:
// `/bin/sh -c <wrapper> sh <loginShell> <path> <claudeCmd> [prompt]`, under an
// environment that carries the leak. Run once per login shell the host has.
async function runWrapper(
  claudeCmd: string,
  prompt?: string,
  loginShell = "/bin/sh",
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
      "/bin/sh",
      "-c",
      AGENT_SESSION_WRAPPER,
      "sh",
      loginShell,
      `/fixture/shims:${AGENT_SESSION_PATH_SEED}`,
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

// Every POSIX login shell this host has: the wrapper must carry the command and
// prompt identically whichever one the account uses.
const LOGIN_SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter(
  (sh) => Bun.which(sh) !== null,
);

describe.each(LOGIN_SHELLS)("the wrapper, executed under %s", (loginShell) => {
  test("delivers the command and the prompt, and drops the leak", async () => {
    const prompt = "fix the 'quoting' bug\nin $HOME/notes & elsewhere";
    const res = await runWrapper(PROBE_CMD, prompt, loginShell);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`SETTINGS<${SETTINGS}>`);
    expect(res.stdout).toContain(`PROMPT<${prompt}>`);

    // The pane keeps what it was given...
    expect(res.stdout).toContain("TMUX_PANE=%99");
    expect(res.stdout).toContain("SINGULARITY_CONVERSATION_ID=conv-test");
    expect(res.stdout).toContain("SINGULARITY_PARENT_HOST=att-test-w6l1");
    // ...including the toolchain on PATH, whatever the login profile does...
    expect(res.stdout).toMatch(/^PATH=.*\/fixture\/shims/m);
    // ...and nothing it was not.
    expect(res.stdout).not.toContain(LEAKED_NAMESPACE_VAR);
    expect(res.stdout).not.toContain("SOCKET_PATH=");
    expect(res.stdout).not.toContain("ZZ_ENVTEST_PROBE");
  });

  test("runs with no prompt at all", async () => {
    const res = await runWrapper(
      'printf "NARGS<%d>\\n" $#',
      undefined,
      loginShell,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("NARGS<0>");
  });
});
