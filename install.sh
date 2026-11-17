#!/usr/bin/env bash
# One-command install of equin, from a clean machine to a running app.
#
#   curl -fsSL https://raw.githubusercontent.com/equinai/equin/main/install.sh | bash
#   ./install.sh                  # from inside a clone or fork you already have
#
# Options (after `bash -s --` when piped):
#   --dir <path>     where to clone (default ~/equin; ignored inside a checkout)
#   --repo <url>     what to clone (default the canonical repo — pass your fork)
#   --no-shell-rc    do not add the `mise activate` line to your shell rc
#
# Every step checks before it acts, so re-running it resumes where it stopped.
# The steps are docs/setup.md's install sequence; the doctor
# (plugins/framework/plugins/cli/plugins/doctor/doctor.sh) is what decides
# whether anything required is still missing.
#
# Every message it prints to the person installing follows the installer
# message rules (plugins/infra/plugins/launcher/plugins/installer-notice/CLAUDE.md):
# no internal names, what equin was doing and why, why it was blocked, what to
# do now and what skipping costs — raw facts only on a `details:` line (fail).
#
# This file lives at the repo root on purpose: its URL above is the documented
# entry point and must not move when plugins do.

set -euo pipefail

# The data root, by paths/data-root-layout's rule (data-root-layout.ts): the legacy dir
# while an install not yet migrated has it (`./equin data-dir migrate` moves
# it), else ~/.equin.
data_root() {
  if { [ -e "$HOME/.singularity" ] || [ -L "$HOME/.singularity" ]; } && ! [ "$HOME/.singularity" -ef "$HOME/.equin" ]; then
    printf '%s\n' "$HOME/.singularity"
  else
    printf '%s\n' "$HOME/.equin"
  fi
}

# The first folder the install must write to that refuses a write or a
# rename, or nothing when every one takes them. Probed only inside a Claude
# Code shell (CLAUDECODE is set): its sandbox lets commands write only inside
# the project, so a compile killed mid-rename there left a half-written build
# behind (the 2026-11 install report). Same probe as the doctor's
# (plugins/framework/plugins/cli/plugins/doctor/doctor.sh) — keep them alike.
refused_write_dir() {
  for dir in "$(data_root)" "${CARGO_HOME:-$HOME/.cargo}"; do
    [ -d "$dir" ] || dir="$HOME"
    probe="$dir/.equin-write-probe.$$"
    if ! { : > "$probe" && mv "$probe" "$probe.moved" && rm -f "$probe.moved"; } 2>/dev/null; then
      rm -f "$probe" "$probe.moved" 2>/dev/null || true
      printf '%s\n' "$dir"
      return
    fi
  done
}

# Everything is inside main(), called on the last line: under `curl | bash`,
# bash reads the script from the same pipe the commands below inherit as stdin,
# so a command that reads stdin could otherwise swallow the rest of the script.
# Parsing main() whole first leaves nothing for them to eat.
main() {
  # As typed, for the command a refusal asks the user to run again.
  ARGS="$*"

  REPO_URL="https://github.com/equinai/equin"
  INSTALL_DIR="$HOME/equin"
  EDIT_RC=1

  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) INSTALL_DIR="$2"; shift 2 ;;
      --repo) REPO_URL="$2"; shift 2 ;;
      --no-shell-rc) EDIT_RC=0; shift ;;
      -h|--help) echo "usage: install.sh [--dir <path>] [--repo <url>] [--no-shell-rc]"; exit 0 ;;
      *) echo "install.sh: unknown option '$1' (see --help)" >&2; exit 2 ;;
    esac
  done

  OS="$(uname -s)"

  # Run from a checkout (./install.sh) → install that checkout; piped → clone.
  SELF_DIR=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -x "$SELF_DIR/equin" ] && [ -f "$SELF_DIR/mise.toml" ]; then
      INSTALL_DIR="$SELF_DIR"
    else
      SELF_DIR=""
    fi
  fi

  case "${SHELL:-}" in
    */bash) RC="$HOME/.bashrc"; SH_NAME=bash ;;
    *) RC="$HOME/.zshrc"; SH_NAME=zsh ;;
  esac

  # ── 0. Say what will happen, before anything does ──────────────────────────
  if [ "$(id -u)" = "0" ]; then
    fail "equin can't be installed from the administrator (root) account: its database refuses to run as root, so equin could never start. Run the installer from your normal account. On a server with only root, create one first: adduser --disabled-password --gecos '' equin && su - equin" \
      "id -u = 0; initdb refuses to run as root"
  fi

  # ── Not from inside Claude Code's protected shell ──────────────────────────
  if [ -n "${CLAUDECODE:-}" ]; then
    refused="$(refused_write_dir)"
    if [ -n "$refused" ]; then
      if [ -n "$SELF_DIR" ]; then
        again="cd '$INSTALL_DIR' && ./install.sh"
      else
        again="curl -fsSL https://raw.githubusercontent.com/equinai/equin/main/install.sh | bash -s -- $ARGS"
      fi
      cat >&2 <<EOF

  equin can't be installed from this window.

  equin installs its app, its database and the tools it builds with in your
  home folder, so it keeps running after this window closes.
  This window is Claude Code, which runs commands in a protected mode that
  can't save files outside the current project, so the install would stop
  part-way through.

  What to do: open the Terminal app and run the same command there:

      $again

  Nothing has been changed on your machine yet. This step can't be skipped:
  equin can't run without those files.

  Details: CLAUDECODE is set; creating and renaming a file in $refused was refused.
EOF
      exit 1
    fi
  fi

  cat <<EOF

  equin installer. This will:
    1. install the Xcode command-line tools, if missing (macOS), or git and a
       C compiler (Linux, apt) — and let equin keep running while nobody is
       logged in (Linux); asks for your password once
    2. install mise (it installs the exact Bun, Go and Rust versions equin is
       built with), and add one line to $RC so new terminals find them
    3. $( [ -n "$SELF_DIR" ] && echo "use the copy of equin at $INSTALL_DIR" || echo "download equin's code into $INSTALL_DIR" )
    4. install those exact Bun, Go and Rust versions
    5. start equin in the background (with its own database) and build it:
       ~10-15 minutes
EOF
  if [ "$OS" = "Darwin" ]; then
    echo "  The app then comes back by itself at every login, after a reboot too."
  else
    echo "  The app then comes back by itself at every boot."
  fi
  echo "  Nothing else on your machine is changed. No Homebrew, no database server for the whole machine."

  # ── 1. Xcode command-line tools / git ──────────────────────────────────────
  if [ "$OS" = "Darwin" ]; then
    if ! xcode-select -p >/dev/null 2>&1; then
      say "Installing Apple's command-line tools, which equin needs to download its code and build parts of itself"
      # The headless route (the one Homebrew's installer uses): the marker file
      # makes softwareupdate list the tools, so this works over ssh too, where
      # `xcode-select --install`'s dialog has nobody to click it.
      marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
      sudo touch "$marker"
      label="$(softwareupdate -l 2>/dev/null | grep -E '^\s*\*?\s*Label: Command Line Tools' | sed 's/^[^:]*: //' | sort -V | tail -1 || true)"
      if [ -n "$label" ]; then
        sudo softwareupdate -i "$label" --verbose
        sudo rm -f "$marker"
      else
        sudo rm -f "$marker"
        echo "macOS's software update did not offer the tools, so Apple's installer opens instead."
        xcode-select --install || true
        echo "Click Install in the window that opened; the install continues once it finishes."
        until xcode-select -p >/dev/null 2>&1; do sleep 5; done
      fi
      xcode-select -p >/dev/null 2>&1 || fail "Apple's command-line tools did not install. equin needs them to download its code and build parts of itself on your Mac. Install them with: xcode-select --install — then run the installer again; it picks up where it stopped." \
        "xcode-select -p finds no developer directory"
    fi
  else
    # The Linux counterpart of the Xcode step: what the app needs from the
    # system, through the distro's package manager, with one sudo: git, curl
    # and a C compiler for the toolchain.
    pkgs=""
    command -v git >/dev/null 2>&1 || pkgs="$pkgs git"
    command -v curl >/dev/null 2>&1 || pkgs="$pkgs curl"
    command -v cc >/dev/null 2>&1 || pkgs="$pkgs build-essential"
    if [ -n "$pkgs" ]; then
      command -v apt-get >/dev/null 2>&1 || fail "equin needs git, curl and a C compiler to download its code and build parts of itself, and this system has no apt to install them with. Install them with your system's package manager, then run the installer again." \
        "missing:$pkgs; no apt-get on PATH"
      say "Installing$pkgs, which equin needs to download its code and build parts of itself (asks for your password)"
      sudo apt-get update -qq
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $pkgs
    fi
    # Lingering: without it systemd stops the user's services — the gateway,
    # and with it every agent — when the last session closes, and never starts
    # them at boot. `./equin start` refuses without it.
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != "yes" ]; then
      say "Letting equin keep running while nobody is logged in, and start when the machine boots (asks for your password)"
      sudo loginctl enable-linger "$(id -un)"
    fi
  fi

  # ── 2. mise ────────────────────────────────────────────────────────────────
  MISE="$HOME/.local/bin/mise"
  if ! command -v mise >/dev/null 2>&1 && [ ! -x "$MISE" ]; then
    say "Installing mise"
    curl -fsSL https://mise.run | sh
  fi
  command -v mise >/dev/null 2>&1 && MISE="$(command -v mise)"
  [ -x "$MISE" ] || fail "mise did not install. equin needs it to install the exact Bun, Go and Rust versions it is built with. Check your internet connection, then run the installer again." \
    "no executable at $MISE after: curl -fsSL https://mise.run | sh"

  ACTIVATE="eval \"\$($MISE activate $SH_NAME)\""
  if [ "$EDIT_RC" = "1" ]; then
    if ! grep -qs "mise activate" "$RC"; then
      say "Letting new terminals find equin's tools (one line added to $RC)"
      printf '\n# mise: the Bun/Go/Rust releases equin runs on\n%s\n' "$ACTIVATE" >> "$RC"
    fi
  fi
  # This process: mise's shims on PATH, which is what the doctor calls active.
  SHIMS="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims"
  export PATH="$SHIMS:$(dirname "$MISE"):$PATH"

  # ── 3. The repo ────────────────────────────────────────────────────────────
  if [ -z "$SELF_DIR" ]; then
    if [ -d "$INSTALL_DIR/.git" ]; then
      say "Using the copy of equin already at $INSTALL_DIR"
    elif [ -e "$INSTALL_DIR" ]; then
      fail "The folder $INSTALL_DIR already holds something else, so equin will not install over it. Move it away, or install somewhere else with --dir <another folder>." \
        "$INSTALL_DIR exists and has no .git"
    else
      say "Downloading equin's code into $INSTALL_DIR"
      git clone "$REPO_URL" "$INSTALL_DIR"
    fi
  fi
  cd "$INSTALL_DIR"

  # ── 4. Toolchain ───────────────────────────────────────────────────────────
  # Its postinstall runs the repo's `setup` (trust, git hooks) and the doctor,
  # which fails this step if anything required is still missing.
  say "Installing Bun, Go and Rust (the exact versions equin is built with)"
  "$MISE" trust
  # A failed install keeps every release it did install, so re-running resumes.
  if ! "$MISE" install; then
    fail "Bun, Go and Rust did not finish installing; what went wrong is in the output above. Run the installer again: it picks up where it stopped (cd $INSTALL_DIR && ./install.sh)." \
      "mise install exited non-zero"
  fi

  # ── 5. Start, 6. build ─────────────────────────────────────────────────────
  # No Claude Code install: the app runs the build the Agent SDK ships (with
  # the toolchain's dependencies), and the user signs in from the app.
  say "Starting equin in the background, with its own database"
  if ! ./equin start; then
    fail "equin could not start; what stopped it is just above. Once that is sorted, run the installer again: it picks up where it stopped (cd $INSTALL_DIR && ./install.sh)." \
      "./equin start exited non-zero"
  fi

  STATUS="$(data_root)/worktrees/singularity/build-status.json"
  before="$(grep -o '"buildId": *"[^"]*"' "$STATUS" 2>/dev/null || true)"
  say "Building equin (the long step: about 10 minutes)"
  # --skip-checks: this deploys main, whose tree already passed the full check
  # pass when it was pushed (the cheap alwaysRun subset still runs). The full
  # pass is an authoring gate, and some of it needs headless Chromium (the
  # layout-geometry suite) — an on-demand dependency (infra/deps) installed the
  # first time a check, an e2e script or an agent's browser asks for it, never
  # to launch the app.
  ./equin build --allow-main --skip-checks
  # The receipt is the authority on whether it deployed, not the exit code.
  after="$(grep -o '"buildId": *"[^"]*"' "$STATUS" 2>/dev/null || true)"
  if [ -z "$after" ] || [ "$after" = "$before" ] || ! grep -q '"status": *"ok"' "$STATUS"; then
    fail "equin did not finish building, so it cannot open yet; what went wrong is in the output above. Run the installer again to retry (cd $INSTALL_DIR && ./install.sh)." \
      "no new ok deploy receipt in $STATUS"
  fi

  # ── 7. Done ────────────────────────────────────────────────────────────────
  say "equin is running: http://equin.localhost:9000"
  echo "  equin's code is in $INSTALL_DIR"
  if [ "$EDIT_RC" = "1" ]; then
    echo "  Open a new terminal to use ./equin there (new terminals find its tools)."
  fi
}

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
# fail <message> <details>: stop the install. The message follows the
# installer message rules (plugins/infra/plugins/launcher/plugins/installer-notice/CLAUDE.md):
# what equin was doing and why, what blocked it — in the user's words, no
# internal names — and what to do now; the raw facts (paths, exit codes,
# tool output) go in <details>, printed apart and dimmed.
fail() {
  printf '\n\033[31m%s\033[0m\n' "$1" >&2
  [ -n "${2:-}" ] && printf '\033[2m    details: %s\033[0m\n' "$2" >&2
  exit 1
}

main "$@"
