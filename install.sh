#!/usr/bin/env bash
# One-command install of Singularity, from a clean machine to a running app.
#
#   curl -fsSL https://raw.githubusercontent.com/Conchylicultor/singularity/main/install.sh | bash
#   ./install.sh                  # from inside a clone or fork you already have
#
# Options (after `bash -s --` when piped):
#   --dir <path>     where to clone (default ~/singularity; ignored inside a checkout)
#   --repo <url>     what to clone (default the canonical repo — pass your fork)
#   --no-shell-rc    do not add the `mise activate` line to your shell rc
#
# Every step checks before it acts, so re-running it resumes where it stopped.
# The steps are docs/setup.md's install sequence; the doctor
# (plugins/framework/plugins/cli/plugins/doctor/doctor.sh) is what decides
# whether anything required is still missing.
#
# This file lives at the repo root on purpose: its URL above is the documented
# entry point and must not move when plugins do.

set -euo pipefail

# Everything is inside main(), called on the last line: under `curl | bash`,
# bash reads the script from the same pipe the commands below inherit as stdin,
# so a command that reads stdin could otherwise swallow the rest of the script.
# Parsing main() whole first leaves nothing for them to eat.
main() {

  REPO_URL="https://github.com/Conchylicultor/singularity"
  INSTALL_DIR="$HOME/singularity"
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
    if [ -x "$SELF_DIR/singularity" ] && [ -f "$SELF_DIR/mise.toml" ]; then
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
    die "do not run as root: Postgres' initdb refuses to, so the app cannot start. Run as a normal user (on a server: adduser --disabled-password --gecos '' singularity && su - singularity)."
  fi

  cat <<EOF

  Singularity installer. This will:
    1. install the Xcode command-line tools, if missing (macOS), or git, a C
       compiler and the system libraries headless Chromium needs (Linux, apt)
       — and enable lingering so the app runs with nobody logged in (Linux);
       asks for your password once
    2. install mise, and add one line to $RC so new terminals find its tools
    3. $( [ -n "$SELF_DIR" ] && echo "use the checkout at $INSTALL_DIR" || echo "clone $REPO_URL into $INSTALL_DIR" )
    4. install the exact Bun, Go, tmux and Rust releases mise.lock records
    5. install Claude Code — agents run on it and need a Claude account to sign in
    6. start the app (gateway + its own Postgres) and build it: ~10-15 minutes
EOF
  if [ "$OS" = "Darwin" ]; then
    echo "  The app then comes back by itself at every login, after a reboot too."
  else
    echo "  The app then comes back by itself at every boot (a systemd user service)."
  fi
  echo "  Nothing else on your machine is changed. No Homebrew, no system Postgres."

  # ── 1. Xcode command-line tools / git ──────────────────────────────────────
  if [ "$OS" = "Darwin" ]; then
    if ! xcode-select -p >/dev/null 2>&1; then
      say "Installing the Xcode command-line tools (git, and the linker Rust uses)"
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
        echo "softwareupdate offered no Command Line Tools; opening Apple's installer instead."
        xcode-select --install || true
        echo "Waiting for the installer dialog to finish…"
        until xcode-select -p >/dev/null 2>&1; do sleep 5; done
      fi
      xcode-select -p >/dev/null 2>&1 || die "the Xcode command-line tools did not install. Run: xcode-select --install"
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
      command -v apt-get >/dev/null 2>&1 || die "missing:$pkgs. Install them with your distro's package manager (git, curl, a C compiler), then re-run."
      say "Installing$pkgs (apt; asks for your password)"
      sudo apt-get update -qq
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $pkgs
    fi
    # Lingering: without it systemd stops the user's services — the gateway,
    # and with it every agent — when the last session closes, and never starts
    # them at boot. `./singularity start` refuses without it.
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != "yes" ]; then
      say "Enabling lingering for $(id -un), so the app runs with nobody logged in (asks for your password)"
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
  [ -x "$MISE" ] || die "mise did not install at $MISE."

  ACTIVATE="eval \"\$($MISE activate $SH_NAME)\""
  if [ "$EDIT_RC" = "1" ]; then
    if ! grep -qs "mise activate" "$RC"; then
      say "Activating mise in new terminals ($RC)"
      printf '\n# mise: the Bun/Go/tmux/Rust releases Singularity runs on\n%s\n' "$ACTIVATE" >> "$RC"
    fi
  fi
  # This process: mise's shims on PATH, which is what the doctor calls active.
  SHIMS="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims"
  export PATH="$SHIMS:$(dirname "$MISE"):$PATH"

  # ── 3. The repo ────────────────────────────────────────────────────────────
  if [ -z "$SELF_DIR" ]; then
    if [ -d "$INSTALL_DIR/.git" ]; then
      say "Using the existing clone at $INSTALL_DIR"
    elif [ -e "$INSTALL_DIR" ]; then
      die "$INSTALL_DIR exists and is not a git clone. Move it, or pass --dir <another path>."
    else
      say "Cloning $REPO_URL into $INSTALL_DIR"
      git clone "$REPO_URL" "$INSTALL_DIR"
    fi
  fi
  cd "$INSTALL_DIR"

  # ── 4. Toolchain ───────────────────────────────────────────────────────────
  # Its postinstall runs the repo's `setup` (trust, git hooks) and the doctor,
  # which fails this step if anything required is still missing.
  say "Installing the toolchain mise.lock records"
  "$MISE" trust
  "$MISE" install

  # ── 5. Claude Code ─────────────────────────────────────────────────────────
  claude_bin="$(command -v claude 2>/dev/null || true)"
  [ -z "$claude_bin" ] && [ -x "$HOME/.local/bin/claude" ] && claude_bin="$HOME/.local/bin/claude"
  if [ -z "$claude_bin" ]; then
    say "Installing Claude Code"
    curl -fsSL https://claude.ai/install.sh | bash
    claude_bin="$HOME/.local/bin/claude"
  fi

  # ── 6. Start, 7. build ─────────────────────────────────────────────────────
  say "Starting the gateway and its Postgres"
  ./singularity start

  # Linux: the build's layout checks launch headless Chromium, which links
  # against system libraries a server image lacks (NSS, ATK, libgbm, ALSA…).
  # Playwright's own installer knows the list per distro; it runs from the
  # workspace's pinned playwright, resolved the way the playwright-browser
  # dependency resolves it (plugins/infra/plugins/deps/plugins/playwright-browser).
  # Needs node_modules, which `start` just installed.
  if [ "$OS" != "Darwin" ] && command -v apt-get >/dev/null 2>&1; then
    BUN="$("$MISE" which bun)"
    PW_CLI="$("$BUN" -e 'const p = Bun.resolveSync("playwright/package.json", process.argv[1]); const { join, dirname } = require("node:path"); console.log(join(dirname(p), require(p).bin.playwright));' "$INSTALL_DIR/plugins/infra/plugins/deps/plugins/playwright-browser")"
    say "Installing the system libraries headless Chromium needs (apt; asks for your password)"
    sudo DEBIAN_FRONTEND=noninteractive "$BUN" "$PW_CLI" install-deps chromium
  fi

  STATUS="$HOME/.singularity/worktrees/singularity/build-status.json"
  before="$(grep -o '"buildId": *"[^"]*"' "$STATUS" 2>/dev/null || true)"
  say "Building the app (the long step)"
  ./singularity build --allow-main
  # The receipt is the authority on whether it deployed, not the exit code.
  after="$(grep -o '"buildId": *"[^"]*"' "$STATUS" 2>/dev/null || true)"
  if [ -z "$after" ] || [ "$after" = "$before" ] || ! grep -q '"status": *"ok"' "$STATUS"; then
    die "the build did not record a deploy ($STATUS). Re-run ./install.sh from $INSTALL_DIR to retry."
  fi

  # ── 8. Done ────────────────────────────────────────────────────────────────
  signed_in=0
  case "$("$claude_bin" auth status --json 2>/dev/null || true)" in
    *'"loggedIn": true'* | *'"loggedIn":true'*) signed_in=1 ;;
  esac
  if [ "$signed_in" = "0" ] && [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    say "Sign in to Claude Code, so the app can run agents"
    if "$claude_bin" auth login </dev/tty; then signed_in=1; fi
  fi

  say "Singularity is running: http://singularity.localhost:9000"
  echo "  Checkout: $INSTALL_DIR"
  [ "$EDIT_RC" = "1" ] && echo "  Open a new terminal to use ./singularity (mise is active there)."
  if [ "$signed_in" = "0" ]; then
    echo "  One step left, for agents: $claude_bin auth login"
  fi
}

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31minstall.sh: %s\033[0m\n' "$*" >&2; exit 1; }

main "$@"
