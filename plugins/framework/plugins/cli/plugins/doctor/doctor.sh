#!/bin/sh
# equin's prerequisite check: names EVERY missing prerequisite in one run,
# each with the command that fixes it, then exits 1 if anything was missing.
# Claude Code is not one: the app runs the build the Agent SDK ships (installed
# with its dependencies) and the user signs in from the app
# (infra/claude-cli/sign-in).
#
# POSIX sh on purpose: its most important case is Bun itself missing, where no
# TypeScript can run. Run it from the checkout it checks (the cwd is the
# checkout):
#
#   mise run doctor      — by hand; also the tail of every `mise install`
#   ./equin start / build — their first step (see ./cli/prerequisites.ts)
#
# It asks only "is it there". Which release (floors, holds, shadowing) is
# `toolchain:resolved`'s job, and the tool list itself comes from mise.toml +
# mise.lock through mise, so adding a tool there needs no change here.
#
# Its messages follow the installer message rules
# (plugins/infra/plugins/launcher/plugins/installer-notice/CLAUDE.md): a person
# installing equin reads them, so <what> and <why> name no internal part and
# say what it is for; raw facts (paths, tool output) go in <details>.
#
# Probes are builtins plus the tools being checked (id, uname, xcode-select,
# git, mise), so the test can stub every one of them on PATH — and, inside a
# Claude Code shell only, mv and rm for the write probe.

missing=0
report=""

# miss <what> <why> <details> <fix...> — <details> may be "".
miss() {
  missing=$((missing + 1))
  report="$report
  x $1
      $2"
  if [ -n "$3" ]; then
    report="$report
      details: $3"
  fi
  shift 3
  for fix in "$@"; do
    report="$report
      \$ $fix"
  done
}

# ── Not root ────────────────────────────────────────────────────────────────
# Same fact as assertSupportedHost (plugins/infra/plugins/launcher).
if [ "$(id -u)" = "0" ]; then
  miss "Running as root (the administrator account)" \
    "equin's database refuses to run as root, so equin could never start. Run it from your normal account." \
    "id -u = 0; initdb refuses root" \
    "adduser --disabled-password --gecos '' equin && su - equin"
fi

# ── Not inside Claude Code's protected shell ────────────────────────────────
# Claude Code's sandbox lets commands write only inside the project. equin's
# data root and cargo's home are outside it, so a build there dies part-way —
# a rustc killed mid-rename once left a half-written cargo cache behind (the
# 2026-11 install report). Probed only when CLAUDECODE is set; the same probe
# as install.sh's refused_write_dir — keep them alike.
if [ -n "$CLAUDECODE" ]; then
  if [ -n "$EQUIN_DIR" ]; then
    data_root="$EQUIN_DIR"
  elif { [ -e "$HOME/.singularity" ] || [ -L "$HOME/.singularity" ]; } && ! [ "$HOME/.singularity" -ef "$HOME/.equin" ]; then
    data_root="$HOME/.singularity"
  else
    data_root="$HOME/.equin"
  fi
  for dir in "$data_root" "${CARGO_HOME:-$HOME/.cargo}"; do
    [ -d "$dir" ] || dir="$HOME"
    probe="$dir/.equin-write-probe.$$"
    if ! { : > "$probe" && mv "$probe" "$probe.moved" && rm -f "$probe.moved"; } 2>/dev/null; then
      rm -f "$probe" "$probe.moved" 2>/dev/null
      miss "This window can't save equin's files" \
        "It is Claude Code, which runs commands in a protected mode that can't save files outside the current project. equin keeps its app, its database and its build tools in your home folder, so installing or starting it from here stops part-way. Run it from the Terminal app instead: nothing is lost, it picks up where it stopped. (Details: CLAUDECODE is set; creating and renaming a file in $dir was refused.)" \
        "cd '$PWD' && ./install.sh   # in the Terminal app"
      break
    fi
  done
fi

# ── Xcode command-line tools (macOS) and a working git ──────────────────────
os="$(uname -s)"
if [ "$os" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  miss "Apple's command-line tools (Xcode)" \
    "equin needs them to download its code and build parts of itself on your Mac." \
    "xcode-select -p finds no developer directory" \
    "xcode-select --install"
elif ! git --version >/dev/null 2>&1; then
  # On macOS without the CLT, /usr/bin/git is a stub — reported above instead.
  miss "git" "equin downloads and saves its own code with git." "" \
    "sudo apt install git curl build-essential   # or your distro's equivalent"
fi

# ── mise, active in the shell ───────────────────────────────────────────────
# The file a NEW terminal reads — the same pick as install.sh: bash on macOS
# opens login shells (first of ~/.bash_profile, ~/.bash_login, ~/.profile),
# bash on Linux non-login ones (~/.bashrc).
case "$SHELL" in
  */bash)
    sh_name=bash
    rc="$HOME/.bashrc"
    if [ "$os" = "Darwin" ]; then
      rc="$HOME/.bash_profile"
      for f in .bash_profile .bash_login .profile; do
        if [ -f "$HOME/$f" ]; then rc="$HOME/$f"; break; fi
      done
    fi
    ;;
  *) rc="$HOME/.zshrc"; sh_name=zsh ;;
esac
activate="echo 'eval \"\$(~/.local/bin/mise activate $sh_name)\"' >> $rc   # then open a new shell"

mise_bin="$(command -v mise 2>/dev/null)"
if [ -z "$mise_bin" ] && [ -x "$HOME/.local/bin/mise" ]; then
  mise_bin="$HOME/.local/bin/mise"
fi

if [ -z "$mise_bin" ]; then
  miss "mise" \
    "It installs the exact Bun, Go and Rust versions equin is built with." "" \
    "curl https://mise.run | sh" "$activate" "mise install"
else
  # Active = either `mise activate` ran in this shell (it exports MISE_SHELL),
  # or its shims are on PATH. Checking PATH for tool install dirs would pass
  # under `mise run` whether or not the user's own shell can find them.
  # The runtime does not need this — it locates the shims itself (miseShimsDir
  # in plugins/infra/plugins/launcher/core, same lookup order as here) — but the
  # shell does: ./equin finds `bun` through the shell's own PATH.
  shims="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims"
  case ":$PATH:" in
    *":$shims:"* | *":$shims/:"*) active=1 ;;
    *) if [ -n "$MISE_SHELL" ]; then active=1; else active=0; fi ;;
  esac
  if [ "$active" = "0" ]; then
    miss "mise is installed, but your terminal does not use it yet" \
      "Without it your terminal cannot find the tools ./equin runs on." \
      "mise not active in your shell: no MISE_SHELL, $shims not on PATH" \
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
    miss "The links your tools start through are broken" \
      "No Bun or Go program — equin included — can start until mise rebuilds them." \
      "mise shims do not resolve (a symlink loop, or mise moved):$broken; spawns fail with posix_spawn ENOENT" \
      "$mise_bin reshim --force"
  fi

  # A shim run in a directory whose mise config asks for a release that is not
  # installed (a cloned third-party repo) installs it on the spot — and that
  # install's reshim is what writes the loop above. Shims must never install:
  # the toolchain is installed explicitly (`mise install`, `toolchain upgrade`).
  # `mise run setup` turns it off, machine-wide.
  if [ "$("$mise_bin" settings get not_found_auto_install 2>/dev/null)" = "true" ]; then
    miss "mise installs missing tools by itself" \
      "Running a tool inside another project can then install another version and break the links every tool starts through." \
      "mise shims install missing tools on first use (not_found_auto_install = true)" \
      "mise run setup"
  fi

  # The ceiling keeps a worktree from also reading main's mise.toml (see
  # plugins/infra/plugins/deps/plugins/mise/core/internal/mise.ts).
  if ! dry="$(MISE_CEILING_PATHS="${PWD%/*}" "$mise_bin" install --dry-run-code 2>&1)"; then
    tools="$(MISE_CEILING_PATHS="${PWD%/*}" "$mise_bin" ls --missing 2>/dev/null | while read -r name version _; do printf '%s ' "$name@$version"; done)"
    # `ls --missing` reads only the install dirs; the dry run also asks each
    # tool whether it works (rust runs ~/.cargo/bin/rustup). When the dirs are
    # all there but a tool did not answer — endpoint security (WithSecure
    # XFENCE) holding the run while it asks the user — name what mise said,
    # not a list that comes back empty.
    if [ -n "$tools" ]; then
      miss "Bun, Go or Rust is not installed yet" \
        "equin is built with these exact versions." \
        "missing: $tools" \
        "mise install"
    else
      said="$(printf '%s\n' "$dry" | { n=0; while IFS= read -r line && [ "$n" -lt 5 ]; do printf '\n        %s' "$line"; n=$((n + 1)); done; })"
      miss "Bun, Go or Rust is installed but did not start" \
        "Something on this machine stopped one of them — often security software waiting for your answer in a dialog. Answer it, then run the fix." \
        "toolchain not usable: every release is on disk, but mise says:$said" \
        "mise install"
    fi
  fi
fi

if [ "$missing" -eq 0 ]; then
  echo "equin prerequisites: all present."
  exit 0
fi
echo "equin prerequisites: $missing missing.$report

The whole setup, step by step, is in docs/setup.md."
exit 1
