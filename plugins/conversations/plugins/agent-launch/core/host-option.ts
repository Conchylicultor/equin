/**
 * The tmux user option a session carries when an agent runtime OTHER than the
 * tmux runtime hosts its process in it (the value names that runtime, e.g.
 * `sdk`). tmux is then only a supervisor and a viewer for the process, so the
 * tmux runtime's pane listing must skip the session rather than adopt it as one
 * of its own conversations — the rule is "hosted by another runtime", and the
 * tmux runtime names no other runtime.
 *
 * Set with `tmux set-option -t <session> @singularity-host <runtime>`; read in
 * a format as `#{@singularity-host}`.
 */
export const TMUX_HOSTED_BY_OPTION = "@singularity-host";
