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
// a closed set. The exec'd process is a login zsh that immediately re-execs
// `env -i <allowlist> zsh -l -c '<claude command>'`: the outer shell exists
// only to expand `$NAME` (it is the one process that can still see tmux's
// injected TMUX / TMUX_PANE and the two `-e` values), and the inner login shell
// starts from exactly this list, rebuilding PATH from the user's own profile
// and then putting mise's shims first (see AGENT_SESSION_INNER).
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

// A minimal PATH so early rc lines that shell out (path_helper itself lives in
// /usr/libexec but is invoked as a plain command by /etc/zprofile) still work.
// The inner login shell replaces this with the user's real PATH.
export const AGENT_SESSION_PATH_SEED = "/usr/bin:/bin:/usr/sbin:/sbin";

// What the inner login shell runs once its profile has built PATH: put mise's
// shims FIRST, then run the Claude command.
//
// The login profile alone is not enough. `zsh -l -c` is a login shell but not
// an interactive one, so it reads ~/.zprofile and never ~/.zshrc — which is
// exactly where `mise activate` lives on a stock setup. On 2026-10-16 that left
// every pane without `bun` (mise's only copy), and every hook Claude Code ran
// as `bun …` — the PreToolUse guards, the subagent stop guard, the question
// relay — failed with exit 127, which Claude Code treats as non-blocking: the
// guards were silently off. So the pane resolves its tools the way the runtime
// tree does (`runtimePath`, launcher/core): through mise's shims, first, from
// the directory the backend itself resolves them from, whatever the user's
// dotfiles say. Shims first and not last for the runtime's reason too: a
// Homebrew or rustup copy ahead of them would win over `mise.toml`.
//
// `$1` is the shims directory, `$2` the Claude command; after `shift 2` the
// prompt (when there is one) is `$1`, as the command expects.
const AGENT_SESSION_INNER = 'PATH="$1:$PATH"; cmd="$2"; shift 2; eval "$cmd"';

// The command string tmux execs, as
// `zsh -l -c <wrapper> zsh <shimsDir> <claudeCmd> [prompt]`.
//
// Nothing is interpolated into it: the shims directory, the Claude command and
// the prompt ride in as positional words, so a command containing single quotes
// (`--settings '{…}'`) needs no escaping and cannot be re-parsed on the way
// through. After `shift 2`, `"$@"` is the prompt when there is one and expands
// to nothing when there is not — which is what keeps the existing contract that
// a short prompt reaches Claude as the command's `$1`.
export const AGENT_SESSION_WRAPPER = [
  'shims="$1"; cmd="$2"; shift 2; exec env -i',
  ...AGENT_SESSION_ENV_ALLOWLIST.map((name) => `${name}="$${name}"`),
  `PATH=${AGENT_SESSION_PATH_SEED}`,
  `zsh -l -c '${AGENT_SESSION_INNER}' zsh "$shims" "$cmd" "$@"`,
].join(" ");
