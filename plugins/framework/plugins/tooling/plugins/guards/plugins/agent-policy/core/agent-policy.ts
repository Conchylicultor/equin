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
// Each command is ONE string, spelled the same in both places:
// `${SINGULARITY_GUARDS_ROOT:-$CLAUDE_PROJECT_DIR}/…`. A human session has no
// SINGULARITY_GUARDS_ROOT, so its guards come from the project; an app launch
// sets it to the checkout its workspace runs the guards of (a worktree: its
// own, so an agent can edit and test them; scratch: the launching backend's).
// In a worktree both copies are loaded, and Claude Code runs identical hook
// commands once (measured 2026-10-24: identical strings ran once, differing
// ones twice) — keep them byte-identical.

/** The checkout whose guard scripts an app-launched agent's hooks run. */
export const GUARDS_ROOT_ENV = "SINGULARITY_GUARDS_ROOT";

/**
 * The root of the workspace an app-launched agent runs in — the boundary
 * `main-edits` / `main-writes` allow writes under. Absent in a human session.
 */
export const WORKSPACE_ROOT_ENV = "SINGULARITY_WORKSPACE_ROOT";

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

const ROOT = `\${${GUARDS_ROOT_ENV}:-$CLAUDE_PROJECT_DIR}`;

function script(rel: string): string {
  return `"${ROOT}/${rel}"`;
}

const PRE_TOOL_USE =
  "command -v bun >/dev/null 2>&1 || { echo 'guards: bun is not on PATH, so no PreToolUse guard can run; every tool call is blocked until it is (an agent pane seeds PATH with the mise shims: runtime-tmux agentSessionPath)' >&2; exit 2; }; " +
  `bun ${script(GUARD_SCRIPTS.preToolUse)}`;

const STOP = `bun ${script(GUARD_SCRIPTS.stop)}`;

/** Every protection an agent runs with. */
export function agentPolicySettings(): AgentPolicySettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher:
            "Bash|Write|Edit|Read|NotebookEdit|Agent|mcp__claude-in-chrome__.*",
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
