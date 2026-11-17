// The protections every agent runs with — hooks and deny rules — declared once.
//
// Two places hand them to Claude Code, and both read THIS — one per session,
// never both:
//   - the repo's `.claude/settings.json`, for any session in a checkout — a
//     human's, or an app-launched worktree agent's (its `hooks` and
//     `permissions.deny` are generated from here by `./equin build`;
//     `guards:claude-settings-in-sync` fails on drift), so the hooks and the
//     scripts they run come from the same commit, and
//   - an app launch whose workspace has no project settings — a scratch dir
//     outside the repo (agent-launch's `agentLaunchPolicy`, `guards: "launch"`).
//
// Each command is rooted at the GUARDS_ROOT variable or else
// `$CLAUDE_PROJECT_DIR`: a checkout session's guards come from the checkout
// itself (a worktree's own, so an agent can edit and test them); a scratch
// launch sets GUARDS_ROOT to the launching backend's checkout.
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
  command: HookCommand;
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

/**
 * The one launcher every hook command runs through, relative to a checkout
 * root: it resolves `bun` itself (PATH, else mise's shims), runs the script
 * from the script's own directory, and fails loudly — with the fix — when there
 * is no bun at all. A bare `bun` in a hook command exited 127 on every call in
 * a Claude Code started from a shell without mise, saying nothing.
 */
export const HOOK_LAUNCHER =
  "plugins/framework/plugins/tooling/plugins/guards/plugins/agent-policy/bin/run-hook.sh";

declare const hookCommandBrand: unique symbol;

/**
 * A hook command, spelled only by {@link hookCommand}: the launcher by absolute
 * path over a bun script. A `string` does not satisfy it, so no hook entry can
 * carry a hand-written `bun …` (the `guards:hook-commands-via-launcher` check
 * holds `.claude/settings.json` to the same).
 */
export type HookCommand = string & { readonly [hookCommandBrand]: true };

// A hook command is run by the CLI's own hook shell, so a literal path is held
// to a plain-path alphabet rather than escaped for it.
const SAFE_ABSOLUTE_RE = /^\/[A-Za-z0-9_./ +-]+$/;
const SAFE_RELATIVE_RE = /^[A-Za-z0-9_+-][A-Za-z0-9_./ +-]*$/;

function launch(root: string, script: string): HookCommand {
  return `/bin/sh "${root}/${HOOK_LAUNCHER}" "${root}/${script}"` as HookCommand;
}

/**
 * The hook command that runs the bun script `script` (relative to `checkout`,
 * an absolute plain path — `REPO_ROOT` for the checkout serving the caller)
 * through the launcher. The one spelling for a hook outside the agent policy
 * (stop-gate, compaction-context, …).
 */
export function hookCommand({
  checkout,
  script,
}: {
  checkout: string;
  script: string;
}): HookCommand {
  if (!SAFE_ABSOLUTE_RE.test(checkout) || !SAFE_RELATIVE_RE.test(script)) {
    throw new Error(
      `hook command: checkout ${JSON.stringify(checkout)} must be absolute and ` +
        `script ${JSON.stringify(script)} relative, both plain (they are spliced into a hook command)`,
    );
  }
  return launch(checkout.replace(/\/+$/, ""), script);
}

/** Whether `command` is spelled by {@link hookCommand} (launcher by absolute path). */
export function isLauncherHookCommand(command: string): boolean {
  const launcher = /^\/bin\/sh "([^"]+)" "[^"]+"/.exec(command)?.[1];
  return launcher?.endsWith(`/${HOOK_LAUNCHER}`) ?? false;
}

// Fails closed. Claude Code blocks a tool call only on exit 2 — any other
// failure is a "non-blocking error" and the call runs unguarded. The guard
// refuses through stdout and exits 0, so a non-zero exit is a crash (no bun —
// the launcher says why — a missing checkout, a throwing guard): turn it into a
// block, its stderr the reason.
const PRE_TOOL_USE =
  `${launch(ROOT, GUARD_SCRIPTS.preToolUse)} || { echo 'guards: the PreToolUse guard could not run (above), so every tool call is blocked until it does' >&2; exit 2; }` as HookCommand;

// Stays fail-open: exit 2 from a stop hook means "keep working", so a crashing
// stop guard would trap the subagent instead of guarding it. The launcher
// exits 1 when it cannot run, which the CLI shows as a hook error.
const STOP = launch(ROOT, GUARD_SCRIPTS.stop);

/** Every protection an agent runs with. */
export function agentPolicySettings(): AgentPolicySettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher:
            "Bash|Write|Edit|Read|NotebookEdit|Agent|ToolSearch|Grep|Glob|mcp__claude-in-chrome__.*",
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
