import { basename, dirname } from "node:path";

// What environment does an agent's shell start from?
//
// Not ours. The tmux server is started by whichever process first talks to the
// default socket — in practice the main backend, after a machine restart — and
// it keeps that process's environment for its whole life. Every `tmux
// new-session` forks from the server, so every agent pane on the box inherited
// the main backend's variables: its namespace, its Unix socket path, its cwd.
// Nobody chose that; the panes simply picked them up. `-e` only ADDS to what
// the server already carries, so it cannot undo any of it.
//
// So the pane's first act is to throw its environment away and rebuild it from
// a closed set. The exec'd process is `/bin/sh`, which immediately re-execs
// `env -i <allowlist> PATH=<toolchain> <login shell> -l -c '<claude command>'`:
// the outer shell exists only to expand `$NAME` (it is the one process that can
// still see tmux's injected TMUX / TMUX_PANE and the two `-e` values), and the
// inner login shell — the ACCOUNT's own (`agentLoginShell`) — starts from
// exactly this list, its profile adding to a PATH that already finds the
// toolchain (`agentSessionPath`).
//
// Why an allowlist and not `tmux set-environment -g -u` per bad variable: the
// set of things a backend's ambient environment may carry is open-ended, so
// naming the bad ones only ever catches the last leak somebody noticed. An
// allowlist makes the tmux server's environment irrelevant by construction.
//
// TMUX_PANE is load-bearing and must stay in the list: tier-1 pane ownership
// (see this plugin's CLAUDE.md) matches a Claude session file's `tmux` stamp
// against the pane it claims, and the CLI can only stamp what it inherits.
export const AGENT_SESSION_ENV_ALLOWLIST = [
  // Identity. Under `env -i` zsh reconstructs HOME from the passwd entry but
  // reads LOGNAME from getlogin(), which on this host answers the console
  // owner rather than the running uid — so all three are passed explicitly.
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  // Terminal + locale. TERM is set by tmux for the pane; the locale variables
  // may be unset upstream, in which case they arrive empty, which POSIX
  // already treats as "not set" for locale resolution.
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // tmux's own injection. TMUX_PANE is how a Claude session claims its pane.
  "TMUX",
  "TMUX_PANE",
  // The two the runtime delivers with `-e`: the conversation id the
  // prepare-commit-msg hook stamps trailers from, and the host Claude's
  // .mcp.json dials back to.
  "SINGULARITY_CONVERSATION_ID",
  "SINGULARITY_PARENT_HOST",
  // Also delivered with `-e`: pins the Claude session to this pane, so it can
  // never migrate into Claude Code's background daemon and inherit whichever
  // pane first spawned that daemon (the Sep 9 misattributed push). See the
  // spawn site in tmux-runtime.ts.
  "CLAUDE_CODE_DISABLE_AGENT_VIEW",
] as const;

// The system directories every PATH starts from, so early profile lines that
// shell out (path_helper itself lives in /usr/libexec but is invoked as a plain
// command by macOS's /etc/zprofile) still work.
export const AGENT_SESSION_PATH_SEED = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * The PATH the inner login shell starts from: the toolchain the runtime itself
 * resolves its tools through (mise's shims — `runtimeShimsDir`, the rule the
 * gateway hands every backend), the directory of the `claude` the pane runs,
 * then the system seed. The user's profile adds to it (macOS's path_helper
 * re-orders the system entries first and keeps the rest).
 *
 * It used to be the seed alone, so an agent found `bun` — and could run
 * `./singularity` at all — only when the user's own shell profile put mise on
 * PATH for a NON-interactive login shell: a `~/.zshenv` line on the one Mac it
 * ran on, which `install.sh` (writing `~/.zshrc`) never creates. On Linux the
 * pane came up with no `bun` and no `claude`.
 */
export function agentSessionPath(opts: {
  shimsDir: string | undefined;
  claudeBin: string;
}): string {
  return [opts.shimsDir, dirname(opts.claudeBin), AGENT_SESSION_PATH_SEED]
    .filter((p): p is string => p !== undefined)
    .join(":");
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
 * The login shell an agent pane runs in: the account's own (its passwd entry),
 * so the pane reads the profile the user actually keeps — zsh on a Mac, usually
 * bash on Linux — and no particular shell is a prerequisite. One without POSIX
 * `-c` argument semantics (fish, nushell) cannot carry the command and prompt
 * as positional words; it gets `/bin/sh`, which every host has.
 */
export function agentLoginShell(accountShell: string): string {
  return POSIX_LOGIN_SHELLS.has(basename(accountShell))
    ? accountShell
    : "/bin/sh";
}

// The command string tmux execs, as
// `/bin/sh -c <wrapper> sh <loginShell> <path> <claudeCmd> [prompt]`.
//
// Nothing is interpolated into it: the login shell rides in as `$1`, the PATH
// as `$2`, the Claude command as `$3` and the prompt as `$4`, so a command
// containing single quotes (`--settings '{…}'`) needs no escaping and cannot be
// re-parsed on the way through. After `shift 3`, `"$@"` is the prompt when there
// is one and expands to nothing when there is not — which is what keeps the
// existing contract that a short prompt reaches Claude as the inner shell's `$1`.
export const AGENT_SESSION_WRAPPER = [
  'shell="$1"; path="$2"; cmd="$3"; shift 3; exec env -i',
  ...AGENT_SESSION_ENV_ALLOWLIST.map((name) => `${name}="$${name}"`),
  'PATH="$path"',
  '"$shell" -l -c "$cmd" "$shell" "$@"',
].join(" ");
