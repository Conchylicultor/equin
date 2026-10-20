import { runtimeShimsDir } from "@plugins/infra/plugins/launcher/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";

// What environment does an agent's shell start from? Every app-launched agent
// is an sdk agent process the runtime starts detached, and its CLI and every
// tool it runs inherit this environment.
//
// Not the backend's. A backend's own environment is whatever its spawner and
// the gateway handed it — its namespace, its Unix socket path, its cwd — and an
// agent that inherited them acted as that backend: its commits, pushes and MCP
// calls carried the wrong identity. (When agents ran in tmux panes, the tmux
// server leaked main's environment into every pane the same way.)
//
// So the agent starts from a closed set. The spawned process is `/bin/sh`,
// which immediately re-execs `env -i <allowlist> PATH=<toolchain> <login
// shell> -l -c '<command>'`: the outer shell is handed exactly the allowlisted
// values (`agentSessionLaunch`), and the inner login shell — the ACCOUNT's own
// (`agentLoginShell`) — starts from exactly this list, its profile adding to a
// PATH that already finds the toolchain (`agentSessionPath`).
//
// Why an allowlist and not a list of bad variables: the set of things a
// backend's ambient environment may carry is open-ended, so naming the bad ones
// only ever catches the last leak somebody noticed.

/**
 * The variables the launch delivers, valued by
 * {@link agentSessionEnv} — whose return type is keyed by this list, so a name
 * here without a value (or the reverse) is a type error, and the allowlist
 * below spreads it, so a delivered name is never dropped by `env -i`.
 *
 * - `SINGULARITY_CONVERSATION_ID` — the conversation id the
 *   prepare-commit-msg hook stamps trailers from (and every hook command names
 *   its conversation by).
 * - `SINGULARITY_PARENT_HOST` — the host the agent's `.mcp.json` dials back to.
 * - `CLAUDE_CODE_DISABLE_AGENT_VIEW` — pins the Claude session to this agent
 *   process, so it can never migrate into Claude Code's background daemon and
 *   inherit whichever process first spawned that daemon (the Sep 9 misattributed
 *   push).
 */
export const AGENT_SESSION_DELIVERED_ENV = [
  "SINGULARITY_CONVERSATION_ID",
  "SINGULARITY_PARENT_HOST",
  "CLAUDE_CODE_DISABLE_AGENT_VIEW",
] as const;

/** The values one agent session is launched with. */
export type AgentSessionEnv = Record<
  (typeof AGENT_SESSION_DELIVERED_ENV)[number],
  string
>;

/**
 * The `-e` values for `conversationId`'s session.
 *
 * SINGULARITY_PARENT_HOST must be a host the gateway actually routes, so it is
 * this backend's own declared runtime namespace rather than a caller-supplied
 * label; `runtimeNamespace()` throws when the process never declared one.
 *
 * CLAUDE_CODE_DISABLE_AGENT_VIEW: Claude Code's agent view can otherwise move a
 * live session into its per-machine background daemon (`←` on an empty prompt,
 * `/background`, the exit dialog), and the daemon hands every session it hosts
 * ITS OWN environment — the one of whichever process first spawned it. A
 * session moved that way keeps working through a stub in this process, so the app cannot
 * tell, but its commits, pushes and MCP calls then carry another
 * conversation's id. The app never uses background sessions, so the session it
 * launched is the only place an agent may run.
 */
export function agentSessionEnv(conversationId: string): AgentSessionEnv {
  return {
    SINGULARITY_CONVERSATION_ID: conversationId,
    SINGULARITY_PARENT_HOST: runtimeNamespace(),
    CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
  };
}

export const AGENT_SESSION_ENV_ALLOWLIST = [
  // Identity. Under `env -i` zsh reconstructs HOME from the passwd entry but
  // reads LOGNAME from getlogin(), which on this host answers the console
  // owner rather than the running uid — so all three are passed explicitly.
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  // Terminal + locale. TERM is `dumb` (no terminal: tool output carries no
  // colour codes); the locale variables may be unset upstream, in which case
  // they arrive empty, which POSIX already treats as "not set".
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // What the launch delivers with `-e` (`agentSessionEnv`).
  ...AGENT_SESSION_DELIVERED_ENV,
] as const;

// The system directories every PATH starts from, so early profile lines that
// shell out (path_helper itself lives in /usr/libexec but is invoked as a plain
// command by macOS's /etc/zprofile) still work.
export const AGENT_SESSION_PATH_SEED = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * The PATH the inner login shell starts from: the toolchain the runtime itself
 * resolves its tools through (mise's shims — `runtimeShimsDir`, the rule the
 * gateway hands every backend), the directory of the `claude` the agent runs,
 * then the system seed. The user's profile adds to it (macOS's path_helper
 * re-orders the system entries first and keeps the rest).
 *
 * It used to be the seed alone, so an agent found `bun` — and could run
 * `./singularity` at all — only when the user's own shell profile put mise on
 * PATH for a NON-interactive login shell: a `~/.zshenv` line on the one Mac it
 * ran on, which `install.sh` (writing `~/.zshrc`) never creates. On Linux the
 * agent came up with no `bun` and no `claude`.
 */
export function agentSessionPath(opts: {
  shimsDir: string | undefined;
  claudeBin: string;
}): string {
  return [opts.shimsDir, parentDir(opts.claudeBin), AGENT_SESSION_PATH_SEED]
    .filter((p): p is string => p !== undefined)
    .join(":");
}

// Path segments by hand, not `node:path`: these are absolute POSIX paths the
// host handed us, and the plugin stays free of platform APIs.
function parentDir(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// Login shells that run `-c <cmd> <$0> <args…>` with POSIX positional
// semantics — what the wrapper's `"$@"` relies on.
const POSIX_LOGIN_SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
]);

/**
 * The login shell an agent runs in: the account's own (its passwd entry),
 * so the agent reads the profile the user actually keeps — zsh on a Mac, usually
 * bash on Linux — and no particular shell is a prerequisite. One without POSIX
 * `-c` argument semantics (fish, nushell) cannot carry the command and prompt
 * as positional words; it gets `/bin/sh`, which every host has.
 */
export function agentLoginShell(accountShell: string): string {
  return POSIX_LOGIN_SHELLS.has(lastSegment(accountShell))
    ? accountShell
    : "/bin/sh";
}

// The command the agent is spawned as:
// `/bin/sh -c <wrapper> sh <loginShell> <path> <command> [args…]`.
//
// Nothing is interpolated into it: the login shell rides in as `$1`, the PATH
// as `$2`, the command as `$3` and its arguments after, so a command
// containing single quotes needs no escaping and cannot be re-parsed on the way
// through. After `shift 3`, `"$@"` is the arguments when there are any and
// expands to nothing when there are not.
export const AGENT_SESSION_WRAPPER = [
  'shell="$1"; path="$2"; cmd="$3"; shift 3; exec env -i',
  ...AGENT_SESSION_ENV_ALLOWLIST.map((name) => `${name}="$${name}"`),
  'PATH="$path"',
  '"$shell" -l -c "$cmd" "$shell" "$@"',
].join(" ");

/**
 * How an agent process is spawned: the argv (`/bin/sh -c <wrapper> sh
 * <loginShell> <path> <command> [args…]`, which re-execs `command` under the
 * account's login shell in the allowlisted environment) and the closed
 * environment that outer shell is given — the delivered values
 * ({@link agentSessionEnv}), `TERM=dumb`, and the rest of the allowlist from
 * this process. `command` is one shell string (the inner login shell runs it
 * with `-c`); `args` become its positional `$1…`.
 */
export function agentSessionLaunch(opts: {
  env: AgentSessionEnv;
  /** The account's shell (its passwd entry), see {@link agentLoginShell}. */
  accountShell: string;
  /** The `claude` the agent runs, whose directory goes on PATH. */
  claudeBin: string;
  command: string;
  args?: readonly string[];
}): { argv: string[]; env: Record<string, string> } {
  const delivered: Record<string, string> = opts.env;
  const env: Record<string, string> = {};
  for (const name of AGENT_SESSION_ENV_ALLOWLIST) {
    env[name] =
      delivered[name] ?? (name === "TERM" ? "dumb" : (process.env[name] ?? ""));
  }
  return {
    argv: [
      "/bin/sh",
      "-c",
      AGENT_SESSION_WRAPPER,
      "sh",
      agentLoginShell(opts.accountShell),
      agentSessionPath({
        shimsDir: runtimeShimsDir(process.env),
        claudeBin: opts.claudeBin,
      }),
      opts.command,
      ...(opts.args ?? []),
    ],
    env,
  };
}
