#!/bin/sh
# The one launcher every Claude Code hook command runs through
# (guards/agent-policy `hookCommand`): `/bin/sh <this file> <absolute .ts path>`,
# the hook payload on stdin.
#
# It resolves `bun` itself, so a hook works from a Claude Code started in a
# shell without mise activated — the case where a bare `bun` in the hook
# command exited 127 on every call and said nothing useful. When it cannot find
# one it says so, with the fix, and exits non-zero (the PreToolUse command turns
# that into a block; a stop hook shows it as a hook error).
#
# POSIX sh and builtins only (plus dirname): nothing here may need the
# toolchain it is looking for.

script=$1
if [ -z "$script" ]; then
  echo "equin hook: run-hook.sh needs the hook script's path" >&2
  exit 1
fi

# From the script's own directory, so mise's bun shim picks the release the
# script's checkout pins (its mise.toml / mise.lock) — whatever the agent's cwd
# (a scratch workspace has none). A hook reads the agent's cwd from its payload.
dir=$(dirname "$script")
cd "$dir" || {
  echo "equin hook: cannot enter $dir, so ${script##*/} cannot run (was the checkout removed?)" >&2
  exit 1
}

bun=$(command -v bun 2>/dev/null)
# Not on PATH: mise's shims, by mise's own lookup order (runtimeShimsDir in
# infra/launcher/runtime-env, the doctor). A shim works without `mise activate`.
shims="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims"
if [ -z "$bun" ] && [ -x "$shims/bun" ]; then
  bun="$shims/bun"
fi

if [ -z "$bun" ]; then
  root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || root="<the equin checkout>"
  {
    echo "equin hook: cannot run ${script##*/}: bun is not on PATH and mise has no bun shim ($shims/bun)."
    echo "  equin's toolchain comes from mise. To fix it:"
    echo "    1. Install mise if it is missing:  curl https://mise.run | sh"
    echo "    2. Install the toolchain:          cd \"$root\" && ~/.local/bin/mise install"
    echo "    3. Activate mise in your shell rc (zsh: echo 'eval \"\$(~/.local/bin/mise activate zsh)\"' >> ~/.zshrc)"
    echo "  then restart Claude Code. \`sh plugins/framework/plugins/cli/plugins/doctor/doctor.sh\`, run in \"$root\", names anything else missing."
  } >&2
  exit 1
fi

exec "$bun" "$script"
