// The protections every agent runs with — hooks and deny rules — declared once.
//
// Two places hand them to Claude Code, and both read THIS:
//   - the repo's `.claude/settings.json`, for a session a human starts in a
//     checkout (its `hooks` and `permissions.deny` are generated from here by
//     `./equin build`; `guards:claude-settings-in-sync` fails on drift), and
//   - every app launch, whatever its workspace (agent-launch's
//     `agentLaunchPolicy`), so an agent whose cwd is outside the repo — a
//     scratch workspace — is guarded too.
//
// Each command is ONE string, spelled the same in both places, rooted at the
// GUARDS_ROOT variable or else `$CLAUDE_PROJECT_DIR`. A human session has no
// GUARDS_ROOT, so its guards come from the project; an app launch sets it to
// the checkout its workspace runs the guards of (a worktree: its own, so an
// agent can edit and test them; scratch: the launching backend's). In a
// worktree both copies are loaded, and Claude Code runs
// identical hook commands once (measured 2026-10-24: identical strings ran
// once, differing ones twice) — keep them byte-identical.
//
// The workspace an app-launched agent runs in (the WORKSPACE_ROOT variable) is
// the boundary `main-edits` / `main-writes` allow writes under; absent in a
// human session.

import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/** The guard entry points, relative to a checkout root. */
export const GUARD_SCRIPTS = {
  preToolUse: "plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts",
  stop: "plugins/framework/plugins/tooling/plugins/guards/bin/stop-guard.ts",
} as const;

export interface PolicyHookCommand {
  type: "command";
  command: string;
}

export interface PolicyHookGroup {
  matcher?: string;
  hooks: PolicyHookCommand[];
}

/** A `hooks` settings map: hook event → its matcher groups. */
export type PolicyHooks = Record<string, PolicyHookGroup[]>;

export interface AgentPolicySettings {
  hooks: PolicyHooks;
  permissions: { deny: string[] };
}

/** The guards' checkout: GUARDS_ROOT when the launch set it, else the project dir. */
const ROOT = `\${${envName("GUARDS_ROOT")}:-$CLAUDE_PROJECT_DIR}`;

function script(rel: string): string {
  return `"${ROOT}/${rel}"`;
}

// `bun` is a mise shim, which picks its version from the CURRENT directory's
// mise.toml / mise.lock — and a scratch workspace has none (nor is there a
// global default: "mise ERROR No version is set for shim: bun"), so every hook
// running a bun script `cd`s into the script's checkout first: its lock picks
// the bun the script is written for. A hook reads the agent's cwd from the hook
// input, never from the process.
function runGuard(rel: string): string {
  return `cd "${ROOT}" && bun ${script(rel)}`;
}

// A hook command is run by the CLI's own hook shell, so a literal path is held
// to a plain-path alphabet rather than escaped for it.
const SAFE_PATH_RE = /^\/[A-Za-z0-9_./ +-]+$/;

/**
 * The hook command that runs the bun script at `scriptPath` (absolute, plain)
 * from the script's own directory, whatever the agent's cwd — so mise resolves
 * `bun` from the checkout holding the script (see `runGuard`). The one spelling
 * for a hook outside the agent policy (stop-gate, compaction-context, …).
 */
export function bunScriptHookCommand(scriptPath: string): string {
  if (!SAFE_PATH_RE.test(scriptPath)) {
    throw new Error(
      `hook script path ${JSON.stringify(scriptPath)} must be absolute and ` +
        `plain (it is spliced into a hook command)`,
    );
  }
  const dir = scriptPath.slice(0, scriptPath.lastIndexOf("/")) || "/";
  return `cd "${dir}" && bun "${scriptPath}"`;
}

// Fails closed. Claude Code blocks a tool call only on exit 2 — any other
// failure is a "non-blocking error" and the call runs unguarded. The guard
// refuses through stdout and exits 0, so a non-zero exit is a crash (bun that
// cannot start, a throwing guard): turn it into a block, its stderr the reason.
const PRE_TOOL_USE =
  "command -v bun >/dev/null 2>&1 || { echo 'guards: bun is not on PATH, so no PreToolUse guard can run; every tool call is blocked until it is (an agent pane seeds PATH with the mise shims: runtime-tmux agentSessionPath)' >&2; exit 2; }; " +
  `${runGuard(GUARD_SCRIPTS.preToolUse)} || { echo 'guards: the PreToolUse guard failed (above), so every tool call is blocked until it runs' >&2; exit 2; }`;

// Stays fail-open: exit 2 from a stop hook means "keep working", so a crashing
// stop guard would trap the subagent instead of guarding it.
const STOP = runGuard(GUARD_SCRIPTS.stop);

/** Every protection an agent runs with. */
export function agentPolicySettings(): AgentPolicySettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher:
            "Bash|Write|Edit|Read|NotebookEdit|Agent|ToolSearch|mcp__claude-in-chrome__.*",
          hooks: [{ type: "command", command: PRE_TOOL_USE }],
        },
      ],
      SubagentStop: [{ hooks: [{ type: "command", command: STOP }] }],
      TeammateIdle: [{ hooks: [{ type: "command", command: STOP }] }],
    },
    // The agent's checkout is chosen by the app; switching worktree from inside
    // a session would leave the app tracking the wrong one.
    permissions: { deny: ["EnterWorktree", "ExitWorktree"] },
  };
}
