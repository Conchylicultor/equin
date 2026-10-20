#!/bin/sh
# Singularity's prerequisite check: names EVERY missing prerequisite in one run,
# each with the command that fixes it, then exits 1 if anything REQUIRED was
# missing. A recommended one (Claude Code) is named with its fix too, but does
# not fail the run: nothing that stands the app up uses it, and the running app
# refuses each use of it with the same fix (infra/claude-cli/availability).
#
# POSIX sh on purpose: its most important case is Bun itself missing, where no
# TypeScript can run. Run it from the checkout it checks (the cwd is the
# checkout):
#
#   mise run doctor      — by hand; also the tail of every `mise install`
#   ./singularity start / build — their first step (see ./cli/prerequisites.ts)
#
# It asks only "is it there". Which release (floors, holds, shadowing) is
# `toolchain:resolved`'s job, and the tool list itself comes from mise.toml +
# mise.lock through mise, so adding a tool there needs no change here.
#
# Probes are builtins plus the tools being checked (id, uname, xcode-select,
# git, mise, claude), so the test can stub every one of them on PATH.

missing=0
report=""
advised=0
advice=""

# miss <what> <why> <fix...>
miss() {
  missing=$((missing + 1))
  report="$report
  x $1
      $2"
  shift 2
  for fix in "$@"; do
    report="$report
      \$ $fix"
  done
}

# advise <what> <why> <fix...> — named with its fix, but not counted as missing.
advise() {
  advised=$((advised + 1))
  advice="$advice
  ! $1
      $2"
  shift 2
  for fix in "$@"; do
    advice="$advice
      \$ $fix"
  done
}

# ── Not root ────────────────────────────────────────────────────────────────
# Same fact as assertSupportedHost (plugins/infra/plugins/launcher).
if [ "$(id -u)" = "0" ]; then
  miss "Running as root" \
    "Postgres' initdb refuses to run as root, so the embedded cluster (and every backend) cannot start. Run as a non-root user." \
    "adduser --disabled-password --gecos '' singularity && su - singularity"
fi

# ── Xcode command-line tools (macOS) and a working git ──────────────────────
os="$(uname -s)"
if [ "$os" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  miss "Xcode command-line tools" \
    "git and the C linker Rust builds with come from them." \
    "xcode-select --install"
elif ! git --version >/dev/null 2>&1; then
  # On macOS without the CLT, /usr/bin/git is a stub — reported above instead.
  miss "git" "The repo, its worktrees and every push run on git." \
    "sudo apt install git curl build-essential   # or your distro's equivalent"
fi

# ── mise, active in the shell ───────────────────────────────────────────────
case "$SHELL" in
  */bash) rc="$HOME/.bashrc"; sh_name=bash ;;
  *) rc="$HOME/.zshrc"; sh_name=zsh ;;
esac
activate="echo 'eval \"\$(~/.local/bin/mise activate $sh_name)\"' >> $rc   # then open a new shell"

mise_bin="$(command -v mise 2>/dev/null)"
if [ -z "$mise_bin" ] && [ -x "$HOME/.local/bin/mise" ]; then
  mise_bin="$HOME/.local/bin/mise"
fi

if [ -z "$mise_bin" ]; then
  miss "mise" \
    "It installs the exact Bun, Go and Rust releases mise.lock records." \
    "curl https://mise.run | sh" "$activate" "mise install"
else
  # Active = either `mise activate` ran in this shell (it exports MISE_SHELL),
  # or its shims are on PATH. Checking PATH for tool install dirs would pass
  # under `mise run` whether or not the user's own shell can find them.
  # The runtime does not need this — it locates the shims itself (miseShimsDir
  # in plugins/infra/plugins/launcher/core, same lookup order as here) — but the
  # shell does: ./singularity finds `bun` through the shell's own PATH.
  shims="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims"
  case ":$PATH:" in
    *":$shims:"* | *":$shims/:"*) active=1 ;;
    *) if [ -n "$MISE_SHELL" ]; then active=1; else active=0; fi ;;
  esac
  if [ "$active" = "0" ]; then
    miss "mise is installed but not active in your shell" \
      "Your shell finds \`bun\` (and so ./singularity) only through mise." \
      "$activate"
  fi

  # Every shim is a symlink to the mise binary. A reshim run by mise while it
  # was itself started as a shim (mise 2026.9.x takes its own path from how it
  # was invoked) points every shim at shims/<tool>, and that one at itself:
  # nothing on the toolchain can start, and backends die with a bare
  # `posix_spawn: No such file or directory`. Seen 2026-09-27
  # (research/2026-09-27-global-mise-shim-self-loop.md). A link that does not
  # resolve (`-e` follows it: a loop or a missing target) is broken either way.
  broken=""
  for shim in "$shims"/*; do
    if [ -L "$shim" ] && [ ! -e "$shim" ]; then broken="$broken ${shim##*/}"; fi
  done
  if [ -n "$broken" ]; then
    miss "mise shims do not resolve (a symlink loop, or mise moved):$broken" \
      "No bun or go can start through them (backends fail with posix_spawn ENOENT)." \
      "$mise_bin reshim --force"
  fi

  # A shim run in a directory whose mise config asks for a release that is not
  # installed (a cloned third-party repo) installs it on the spot — and that
  # install's reshim is what writes the loop above. Shims must never install:
  # the toolchain is installed explicitly (`mise install`, `toolchain upgrade`).
  # `mise run setup` turns it off, machine-wide.
  if [ "$("$mise_bin" settings get not_found_auto_install 2>/dev/null)" = "true" ]; then
    miss "mise shims install missing tools on first use" \
      "A \`bun\` run inside any repo that pins another release installs it, and the reshim that follows can loop every shim." \
      "mise run setup"
  fi

  # The ceiling keeps a worktree from also reading main's mise.toml (see
  # plugins/infra/plugins/deps/plugins/mise/core/internal/mise.ts).
  if ! MISE_CEILING_PATHS="${PWD%/*}" "$mise_bin" install --dry-run-code >/dev/null 2>&1; then
    tools="$(MISE_CEILING_PATHS="${PWD%/*}" "$mise_bin" ls --missing 2>/dev/null | while read -r name version _; do printf '%s ' "$name@$version"; done)"
    miss "Toolchain not installed: ${tools:-see \`mise ls --missing\`}" \
      "The releases mise.lock records for this checkout." \
      "mise install"
  fi
fi

# ── Claude Code, signed in (recommended) ────────────────────────────────────
# Advice, not a requirement: the app builds and runs without it, and agents
# are the one thing that needs it — the app says so where they are launched.
# The same lookup order as resolveClaudeBin() in plugins/infra/plugins/paths/server/internal/bins.ts
# (doctor.test.ts keeps the candidate paths in step).
claude_bin="${SINGULARITY_CLAUDE_BIN:-$(command -v claude 2>/dev/null)}"
if [ -z "$claude_bin" ]; then
  for candidate in "$HOME/.local/bin/claude" "/opt/homebrew/bin/claude" "/usr/local/bin/claude"; do
    if [ -x "$candidate" ]; then claude_bin="$candidate"; break; fi
  done
fi

if [ -z "$claude_bin" ]; then
  advise "Claude Code" "Every agent the app launches runs on it; until then the app runs without agents." \
    "curl -fsSL https://claude.ai/install.sh | bash" "claude auth login"
else
  case "$("$claude_bin" auth status --json 2>/dev/null)" in
    *'"loggedIn": true'* | *'"loggedIn":true'*) ;;
    *) advise "Claude Code is not signed in" "Agents cannot start without an account; the app runs without them." \
      "claude auth login" ;;
  esac
fi

if [ "$advised" -gt 0 ]; then
  recommended="

$advised recommended:$advice"
else
  recommended=""
fi

if [ "$missing" -eq 0 ]; then
  echo "Singularity prerequisites: all required present.$recommended"
  exit 0
fi
echo "Singularity prerequisites: $missing missing.$report$recommended

Setup, in order: docs/setup.md"
exit 1
