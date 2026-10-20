/**
 * The tmux user option a session carries when an agent runtime hosts its
 * process in it (the value names that runtime, e.g. `sdk`): tmux is then only
 * a supervisor and a viewer for the process. Backends from before the tmux
 * runtime was retired adopt every unmarked agent session in a worktree as a
 * tmux conversation, so the mark stays while such a backend can still be
 * running (a checkout built before the retirement).
 *
 * Set with `tmux set-option -t <session> @singularity-host <runtime>`; read in
 * a format as `#{@singularity-host}`.
 */
export const TMUX_HOSTED_BY_OPTION = "@singularity-host";
