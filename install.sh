#!/usr/bin/env bash
# One-command install of equin, from a clean machine to a running app.
#
#   curl -fsSL https://raw.githubusercontent.com/equinai/equin/main/install.sh | bash
#   ./install.sh                  # from inside a clone or fork you already have
#
# Options (after `bash -s --` when piped):
#   --dir <path>     where to clone (default ~/equin; ignored inside a checkout)
#   --repo <url>     what to clone (default the canonical repo — pass your fork;
#                    a fork installs its own main)
#   --no-shell-rc    do not add the `mise activate` line to your shell rc
#   --ref <tag|main> which equin to install: a release tag, or main's newest
#                    commit (default: the newest release)
#   --terminal       show the install in this terminal, not in its window
#   --window         show it in its window, or stop if the window can't open
#   --dry-run        emit the event stream of a scripted install and touch
#                    nothing (what the stream test and the window's dev loop run)
#
# Stage 0. Piped (`curl … | bash`), this file is main's, and its first job is
# to hand the install to the release it installs: it downloads that release's
# own install.sh (and the installer window for this system) from the tag's
# GitHub Release, checks every file against the Release's SHA256SUMS, and
# runs it — in the window, or in this terminal when the window can't show
# (`stage0`). A release cut before the window existed is installed by this
# script's own steps. Run from a checkout (./install.sh), it installs that
# checkout and skips stage 0. What a Release carries:
# plugins/installer/plugins/release-assets.
#
# Internal, passed by stage 0 and the installer window
# (plugins/installer/plugins/window), which runs this script as its child:
#   --release <tag>  this script is that release's, already verified: run the
#                    steps, never stage 0 again
#   --checkout <ref> what the new clone checks out: the release tag, or main
#   --stage0-only    stop after stage 0, printing what it decided (its test)
#   --events-fd <n>  write the install's events (plugins/installer/core,
#                    protocol v1: one JSON object per line) to fd <n>
#   --control-fd <n> read decisions (retry / quit) from fd <n> when a step fails
#
# The line below says this script accepts --release / --checkout; a Release's
# release.json records it (`handoff`), and stage 0 hands over only when it is
# there. Keep it a line of its own.
# installer-handoff: 1
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

# ── Stage 0: hand the install to the release it installs ─────────────────────

# The release tag grammar as a POSIX ERE. Must equal RELEASE_TAG_ERE in
# plugins/upstream/plugins/release/core (the release-assets:tag-grammar check).
RELEASE_TAG_ERE='^v([0-9]{4})\.([0-9]{2})\.([0-9]{2})(\.([0-9]+))?$'

# stage0: find the release, download it, verify it, and exec its install.sh —
# in the window or in this terminal. Returns (instead of exec'ing) only to
# install with THIS script's steps: when the release predates the hand-off or
# could not be downloaded; it then sets CHECKOUT and says why. A file that does
# not match SHA256SUMS stops the install: nothing unverified ever runs.
stage0() {
  local base want manifest tag dir key bin
  base="${EQUIN_RELEASES_URL:-https://github.com/equinai/equin/releases}"
  base="${base%/}"
  want="${REF:-latest}"
  # A fork installs its own main: the releases are the canonical repo's.
  [ -z "$REF" ] && [ "$REPO_URL" != "$CANONICAL_REPO_URL" ] && want=main
  if [ "$want" != latest ] && [ "$want" != main ] && ! [[ $want =~ $RELEASE_TAG_ERE ]]; then
    fail "--ref takes a release name (like v2026.11.17) or main; '$want' is neither." "--ref $want"
  fi
  if ! command -v curl >/dev/null 2>&1; then
    stage0_fallback "$want" "" "this system has no curl to download it with"
    return 0
  fi

  manifest="$(mktemp "${TMPDIR:-/tmp}/equin-release.XXXXXX")"
  case "$want" in
    latest|main) STAGE0_URL="$base/latest/download/release.json" ;;
    *) STAGE0_URL="$base/download/$want/release.json" ;;
  esac
  if ! curl -fsSL --retry 2 -o "$manifest" "$STAGE0_URL" 2>/dev/null; then
    rm -f "$manifest"
    stage0_fallback "$want" "" "its description could not be downloaded (no internet connection, or no release published yet)"
    return 0
  fi
  tag="$(json_field tag "$manifest")"
  rm -f "$manifest"
  [[ $tag =~ $RELEASE_TAG_ERE ]] || fail "The newest release's description names no release, so the installer stopped. Nothing was installed. Try again later, or install main's newest version with --ref main." \
    "release.json from $STAGE0_URL: tag '$tag'"
  case "$want" in
    latest|main) ;;
    *) [ "$tag" = "$want" ] || fail "The release you asked for ($want) describes itself as another one ($tag), so the installer stopped. Nothing was installed." \
         "release.json from $STAGE0_URL: tag '$tag'" ;;
  esac

  # Every file from that one tag, so a release published meanwhile can never
  # mix with this one.
  dir="$(data_root)/install/bin/$tag"
  mkdir -p "$dir"
  if ! stage0_get "$base/download/$tag" SHA256SUMS "$dir" || ! stage0_get "$base/download/$tag" release.json "$dir"; then
    stage0_fallback "$want" "$tag" "its files could not be downloaded"
    return 0
  fi
  stage0_verify "$dir" release.json
  if [ "$(json_field handoff "$dir/release.json")" != 1 ]; then
    stage0_fallback "$want" "$tag" "it was published before the installer window"
    return 0
  fi
  stage0_get "$base/download/$tag" install.sh "$dir" || { stage0_fallback "$want" "$tag" "its install script could not be downloaded"; return 0; }
  stage0_verify "$dir" install.sh

  case "$OS/$(uname -m)" in
    Darwin/*) key=macos-universal ;;
    Linux/x86_64|Linux/amd64) key=linux-x64 ;;
    Linux/aarch64|Linux/arm64) key=linux-arm64 ;;
    *) key="" ;;
  esac
  bin=""
  if [ "$VIEW" != terminal ] && [ -n "$key" ]; then
    bin="$(json_field "$key" "$dir/release.json")"
    if [ -n "$bin" ]; then
      if stage0_get "$base/download/$tag" "$bin" "$dir"; then
        stage0_verify "$dir" "$bin"
        chmod +x "$dir/$bin"
        bin="$dir/$bin"
      else
        STAGE0_NO_WINDOW="the window could not be downloaded"
        bin=""
      fi
    fi
  fi

  CHECKOUT="$tag"
  [ "$want" = main ] && CHECKOUT=main
  local handoff=(--release "$tag" --checkout "$CHECKOUT")
  if choose_view "$bin" "$dir"; then
    stage0_exec "$bin" --script "$dir/install.sh" -- "${handoff[@]}" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
  fi
  echo "  Installing equin ${tag#v} in this terminal ($VIEW_WHY)."
  stage0_exec bash "$dir/install.sh" "${handoff[@]}" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
}

# stage0_exec <command…>: hand the install over (with --stage0-only, print
# the command instead).
stage0_exec() {
  if [ "$STAGE0_ONLY" = 1 ]; then
    echo "stage0: exec $*"
    exit 0
  fi
  exec "$@"
}

# stage0_fallback <want> <tag or ""> <why>: install with this script's steps,
# in this terminal. Sets CHECKOUT: the tag when one is known, else main.
stage0_fallback() {
  if [ "$VIEW" = window ]; then
    fail "equin's install window can't open: the release could not be prepared, because $3. Run the installer again without --window to install in this terminal." \
      "release ${2:-unknown}; from ${STAGE0_URL:-}"
  fi
  if [ "$1" = main ]; then
    CHECKOUT=main
  elif [ -n "$2" ]; then
    CHECKOUT="$2"
  elif [ "$1" != latest ]; then
    CHECKOUT="$1"
  else
    CHECKOUT=main
  fi
  if [ "$CHECKOUT" = main ]; then
    echo "  Installing main's newest version of equin in this terminal: the newest release could not be used, because $3."
  else
    echo "  Installing equin ${CHECKOUT#v} in this terminal: its install window can't be used, because $3."
  fi
}

# stage0_get <url base> <file> <dir>: download one file of the release.
stage0_get() {
  curl -fsSL --retry 2 -o "$3/$2.part" "$1/$2" 2>/dev/null && mv "$3/$2.part" "$3/$2"
}

# stage0_verify <dir> <file>: the file's sha256 is the one SHA256SUMS lists
# for it, or the install stops — a damaged or changed download is never run.
stage0_verify() {
  # shasum first: macOS's /sbin/sha256sum is BSD's, which reads no list on
  # stdin; Linux without perl's shasum has GNU's sha256sum.
  local line sum="shasum -a 256"
  command -v shasum >/dev/null 2>&1 || sum=sha256sum
  line="$(grep -E "^[0-9a-f]{64}  \*?$2\$" "$1/SHA256SUMS" || true)"
  if [ -z "$line" ] || ! (cd "$1" && printf '%s\n' "$line" | $sum -c --status >/dev/null 2>&1); then
    rm -f "$1/$2"
    fail "The download was damaged or changed, so the installer stopped. Nothing was installed. Run the installer again; if it stops here again, tell us: https://github.com/equinai/equin/issues" \
      "$2 does not match the release's SHA256SUMS (${line:-no entry for it}), in $1"
  fi
}

# json_field <key> <file>: the value of `"key": value` in a release.json
# (written one key per line by release-assets' assemble), quotes dropped;
# empty when the key is absent.
json_field() {
  sed -n "s/^[[:space:]]*\"$1\":[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*\$/\1/p" "$2" | head -n 1
}

# choose_view <window binary or ""> <dir>: 0 = the window, 1 = this terminal,
# with the reason in VIEW_WHY. The window only where it can really show: a
# desktop session, not over SSH or in CI, output on a terminal, not inside a
# sandboxed shell, and the binary's own --probe (a hidden window loading the
# page: on Linux it also catches a missing webkit2gtk, which the loader
# refuses before the program starts). --window skips the guesses but not the
# probe, and stops loudly when the window can't open; --terminal never tries.
choose_view() {
  VIEW_WHY=""
  if [ "$VIEW" = terminal ]; then
    VIEW_WHY="you asked for it with --terminal"; return 1
  fi
  if [ -z "$1" ]; then
    VIEW_WHY="${STAGE0_NO_WINDOW:-this release has no install window for this system}"
  elif [ "$VIEW" != window ]; then
    if [ "$OS" != Darwin ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
      VIEW_WHY="there is no desktop to show a window on"
    elif [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
      VIEW_WHY="you are connected over SSH"
    elif [ -n "${CI:-}" ]; then
      VIEW_WHY="this is an automated run (CI)"
    elif ! [ -t 1 ]; then
      VIEW_WHY="its output is not going to a terminal"
    elif [ -n "${CLAUDECODE:-}${APP_SANDBOX_CONTAINER_ID:-}" ]; then
      VIEW_WHY="this shell runs inside another app's protected mode"
    fi
  fi
  if [ -z "$VIEW_WHY" ] && ! "$1" --probe >/dev/null 2>"$2/probe.log"; then
    VIEW_WHY="the window could not open here (details in $2/probe.log)"
  fi
  [ -z "$VIEW_WHY" ] && return 0
  if [ "$VIEW" = window ]; then
    fail "equin's install window can't open: $VIEW_WHY. Run the installer again without --window to install in this terminal." \
      "--window; ${1:-no window binary}"
  fi
  return 1
}

# Everything is inside main(), called on the last line: under `curl | bash`,
# bash reads the script from the same pipe the commands below inherit as stdin,
# so a command that reads stdin could otherwise swallow the rest of the script.
# Parsing main() whole first leaves nothing for them to eat.
main() {
  # As typed, for the command a refusal asks the user to run again.
  ARGS="$*"

  CANONICAL_REPO_URL="https://github.com/equinai/equin"
  REPO_URL="$CANONICAL_REPO_URL"
  INSTALL_DIR="$HOME/equin"
  EDIT_RC=1
  DRY_RUN=0
  REF=""
  VIEW=""
  RELEASE=""
  CHECKOUT=main
  STAGE0_ONLY=0
  # What the release's script is handed on: the install's own options.
  INSTALL_ARGS=()

  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) INSTALL_DIR="$2"; INSTALL_ARGS+=("$1" "$2"); shift 2 ;;
      --repo) REPO_URL="$2"; INSTALL_ARGS+=("$1" "$2"); shift 2 ;;
      --no-shell-rc) EDIT_RC=0; INSTALL_ARGS+=("$1"); shift ;;
      --ref) REF="$2"; shift 2 ;;
      --terminal) VIEW=terminal; shift ;;
      --window) VIEW=window; shift ;;
      --release) RELEASE="$2"; shift 2 ;;
      --checkout) CHECKOUT="$2"; shift 2 ;;
      --stage0-only) STAGE0_ONLY=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --events-fd) EV_FD="$2"; shift 2 ;;
      --control-fd) CTL_FD="$2"; shift 2 ;;
      -h|--help) echo "usage: install.sh [--dir <path>] [--repo <url>] [--no-shell-rc] [--ref <tag|main>] [--terminal | --window] [--dry-run]"; exit 0 ;;
      *) echo "install.sh: unknown option '$1' (see --help)" >&2; exit 2 ;;
    esac
  done

  OS="$(uname -s)"
  open_streams

  if [ "$DRY_RUN" = "1" ]; then
    dry_run
    exit 0
  fi

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

  # ── Stage 0: piped from main → the release's own script takes over ─────────
  if [ -z "$SELF_DIR" ] && [ -z "$RELEASE" ] && [ -z "$EV_FD" ]; then
    stage0
    if [ "$STAGE0_ONLY" = 1 ]; then
      echo "stage0: own steps, checkout $CHECKOUT"
      exit 0
    fi
  elif [ -n "$SELF_DIR" ] && [ -n "$REF$VIEW" ]; then
    echo "  --ref, --terminal and --window apply to a downloaded install; this installs the copy of equin at $INSTALL_DIR, in this terminal."
  fi
  if [ "$CHECKOUT" != main ] && ! [[ $CHECKOUT =~ $RELEASE_TAG_ERE ]]; then
    echo "install.sh: --checkout takes a release tag or main (got '$CHECKOUT')" >&2; exit 2
  fi
  if [ "$CHECKOUT" = main ]; then
    WHAT="main's newest version of equin"
  else
    WHAT="equin ${CHECKOUT#v}"
  fi

  cat <<EOF

  equin installer. This will:
    1. install the Xcode command-line tools, if missing (macOS), or git and a
       C compiler (Linux, apt) — and let equin keep running while nobody is
       logged in (Linux); asks for your password once
    2. install mise (it installs the exact Bun, Go and Rust versions equin is
       built with), and add one line to $RC so new terminals find them
    3. $( [ -n "$SELF_DIR" ] && echo "use the copy of equin at $INSTALL_DIR" || echo "download $WHAT into $INSTALL_DIR" )
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
  ev_plan "$( [ -n "$SELF_DIR" ] && echo "Use your copy of equin" || echo "Download equin" )"

  # ── 1. Xcode command-line tools / git ──────────────────────────────────────
  if [ "$OS" = "Darwin" ]; then
    if xcode-select -p >/dev/null 2>&1; then
      ev_step tools skipped
    else
      run_step tools install_xcode_tools
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
    fi
    # Lingering: without it systemd stops the user's services — the gateway,
    # and with it every agent — when the last session closes, and never starts
    # them at boot. `./equin start` refuses without it.
    linger=1
    [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = "yes" ] || linger=0
    if [ -z "$pkgs" ] && [ "$linger" = "1" ]; then
      ev_step tools skipped
    else
      run_step tools prepare_linux "$pkgs" "$linger"
      [ "$STEP_RC" = "0" ] || fail "equin could not install what it needs from your system (git, curl, a C compiler) or let itself keep running while nobody is logged in; what went wrong is just above. Once that is sorted, run the installer again: it picks up where it stopped." \
        "apt-get install$pkgs / loginctl enable-linger exited non-zero"
    fi
  fi

  # ── 2. mise ────────────────────────────────────────────────────────────────
  MISE="$HOME/.local/bin/mise"
  if ! command -v mise >/dev/null 2>&1 && [ ! -x "$MISE" ]; then
    run_step mise install_mise
  else
    ev_step mise skipped
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
  if [ -n "$SELF_DIR" ]; then
    ev_step clone skipped
  elif [ -d "$INSTALL_DIR/.git" ]; then
    say "Using the copy of equin already at $INSTALL_DIR"
    ev_step clone skipped
  elif [ -e "$INSTALL_DIR" ]; then
    fail "The folder $INSTALL_DIR already holds something else, so equin will not install over it. Move it away, or install somewhere else with --dir <another folder>." \
      "$INSTALL_DIR exists and has no .git"
  else
    say "Downloading $WHAT into $INSTALL_DIR"
    run_step clone clone_repo
    [ "$STEP_RC" = "0" ] || fail "equin's code did not download into $INSTALL_DIR; what went wrong is just above. Check your internet connection, then run the installer again." \
      "git clone $REPO_URL exited non-zero"
  fi
  cd "$INSTALL_DIR"

  # ── 4. Toolchain ───────────────────────────────────────────────────────────
  # Its postinstall runs the repo's `setup` (trust, git hooks) and the doctor,
  # which fails this step if anything required is still missing.
  say "Installing Bun, Go and Rust (the exact versions equin is built with)"
  # A failed install keeps every release it did install, so re-running resumes.
  run_step toolchain install_toolchain
  if [ "$STEP_RC" != "0" ]; then
    fail "Bun, Go and Rust did not finish installing; what went wrong is in the output above. Run the installer again: it picks up where it stopped (cd $INSTALL_DIR && ./install.sh)." \
      "mise trust / mise install exited non-zero"
  fi

  # ── 5. Start, 6. build ─────────────────────────────────────────────────────
  # No Claude Code install: the app runs the build the Agent SDK ships (with
  # the toolchain's dependencies), and the user signs in from the app.
  say "Starting equin in the background, with its own database"
  run_step start ./equin start
  if [ "$STEP_RC" != "0" ]; then
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
  run_step build ./equin build --allow-main --skip-checks
  [ "$STEP_RC" = "0" ] || fail "equin did not finish building, so it cannot open yet; what went wrong is in the output above. Run the installer again to retry (cd $INSTALL_DIR && ./install.sh)." \
    "./equin build exited non-zero"
  # The receipt is the authority on whether it deployed, not the exit code.
  after="$(grep -o '"buildId": *"[^"]*"' "$STATUS" 2>/dev/null || true)"
  if [ -z "$after" ] || [ "$after" = "$before" ] || ! grep -q '"status": *"ok"' "$STATUS"; then
    fail "equin did not finish building, so it cannot open yet; what went wrong is in the output above. Run the installer again to retry (cd $INSTALL_DIR && ./install.sh)." \
      "no new ok deploy receipt in $STATUS"
  fi

  # ── 7. Done ────────────────────────────────────────────────────────────────
  say "equin is running: http://equin.localhost:9000"
  ev done "\"url\":\"$APP_URL\",\"ms\":$((SECONDS * 1000))"
  echo "  equin's code is in $INSTALL_DIR"
  if [ "$EDIT_RC" = "1" ]; then
    echo "  Open a new terminal to use ./equin there (new terminals find its tools)."
  fi
}

# ── Step bodies ──────────────────────────────────────────────────────────────
# Each runs inside run_step's subshell, under `set -e`: it may print anything
# (that is the step's log) and fails by exiting non-zero. State the rest of the
# install needs (PATH, the current directory) is set by main(), never here.

install_xcode_tools() {
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
}

# prepare_linux <" pkg pkg…" or ""> <linger: 1 already on, 0 to enable>
prepare_linux() {
  if [ -n "$1" ]; then
    say "Installing$1, which equin needs to download its code and build parts of itself (asks for your password)"
    sudo apt-get update -qq
    # shellcheck disable=SC2086 # one word per package
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $1
  fi
  if [ "$2" = "0" ]; then
    say "Letting equin keep running while nobody is logged in, and start when the machine boots (asks for your password)"
    sudo loginctl enable-linger "$(id -un)"
  fi
}

install_mise() {
  say "Installing mise"
  curl -fsSL https://mise.run | sh
}

# The clone, on main — moved to the release tag unless main was asked for, and
# still tracking origin/main, so the app's updates (plugins/upstream) move it
# from one release to the next.
clone_repo() {
  git clone "$REPO_URL" "$INSTALL_DIR"
  if [ "$CHECKOUT" != main ]; then
    git -C "$INSTALL_DIR" checkout -q -B main "refs/tags/$CHECKOUT"
    git -C "$INSTALL_DIR" branch -q --set-upstream-to=origin/main main
  fi
}

install_toolchain() {
  "$MISE" trust
  "$MISE" install
}

# ── The event stream ─────────────────────────────────────────────────────────
# Protocol v1, defined once as a zod schema in plugins/installer/core: one JSON
# object per line, each written by one printf (one write, under PIPE_BUF), on
# the fd the installer window hands over (--events-fd). Without one, every ev*
# call is a no-op and the install prints to the terminal as it always has.
# The --dry-run stream test (plugins/installer/plugins/window/cli) parses this
# emitter's output against the schema, so the two cannot drift.

APP_URL="http://equin.localhost:9000"
EV_FD=""
CTL_FD=""
EV_T=""
EV_T_AT=-1
STEP_ATTEMPT=0
STEP_RC=0

# Check the fds the window handed over, and report the exit status last.
open_streams() {
  local fd
  for fd in "$EV_FD" "$CTL_FD"; do
    [ -z "$fd" ] && continue
    case "$fd" in
      [3-9]) ;;
      *) echo "install.sh: --events-fd / --control-fd take one fd number, 3 to 9 (got '$fd')" >&2; exit 2 ;;
    esac
    if ! { true >&"$fd"; } 2>/dev/null && ! { true <&"$fd"; } 2>/dev/null; then
      echo "install.sh: fd $fd is not open" >&2; exit 2
    fi
  done
  if [ -n "$CTL_FD" ] && [ -z "$EV_FD" ]; then
    echo "install.sh: --control-fd needs --events-fd (a decision answers an event)" >&2; exit 2
  fi
  # A step's commands never see the window's fds: a daemon one of them starts
  # must not hold the event pipe open after the install has ended.
  CLOSE_FDS=""
  [ -n "$EV_FD" ] && CLOSE_FDS="$EV_FD>&-"
  [ -n "$CTL_FD" ] && CLOSE_FDS="$CLOSE_FDS $CTL_FD<&-"
  if [ -n "$EV_FD" ]; then
    trap 'ev exit "\"code\":$?"' EXIT
    # Stopped (the window's Stop, Ctrl-C): exit with the shell's status for
    # the signal, so the exit event says so. Without these, bash runs the
    # EXIT trap with $? = 0 before dying of the signal, and a decision read
    # interrupted by one would be taken as quit.
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
  fi
  return 0
}

# The event's timestamp, re-read from `date` at most once a second (a fork per
# log line would cost seconds over a build's output). Sets EV_T.
ev_now() {
  if [ "$SECONDS" != "$EV_T_AT" ]; then
    EV_T="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    EV_T_AT=$SECONDS
  fi
}

# json_str <text>: JSON_STR = the text as a JSON string. Escapes \ " tab CR and
# ESC (a renderer strips colour codes), drops every other control character.
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  s=${s//$'\033'/\\u001b}
  s=${s//[$'\001'-$'\037']/}
  JSON_STR="\"$s\""
}

# ev <type> [<fields, without braces>]: write one event.
ev() {
  [ -n "$EV_FD" ] || return 0
  ev_now
  printf '{"v":1,"t":"%s","type":"%s"%s}\n' "$EV_T" "$1" "${2:+,$2}" >&"$EV_FD"
}

# ev_step <id> <start|done|skipped|failed> [ms]
ev_step() {
  ev step "\"id\":\"$1\",\"state\":\"$2\"${3:+,\"ms\":$3}"
}

# ev_lines <step id>: each line of stdin, as a log event of that step.
ev_lines() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    json_str "${line:0:4000}"
    ev log "\"step\":\"$1\",\"stream\":\"out\",\"line\":$JSON_STR"
  done
}

# ev_plan <label of the clone step>: the plan event — every top-level step, in
# run order, labelled in the user's words. No estimates yet: a step without a
# measured median shows no number, never a made-up one.
ev_plan() {
  local tools="Prepare your Mac" platform
  [ "$(uname -s)" = "Darwin" ] || tools="Prepare your system"
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
  PLAN_STEPS=""
  plan_step tools "$tools"
  plan_step mise "Install the tool manager"
  plan_step clone "$1"
  plan_step toolchain "Install Bun, Go and Rust"
  plan_step start "Start equin's services"
  plan_step build "Build equin"
  local release=null
  [ -n "$RELEASE" ] && release="\"$RELEASE\""
  ev plan "\"release\":$release,\"platform\":\"$platform\",\"mode\":\"window\",\"steps\":[$PLAN_STEPS]"
}

# plan_step <id> <label>: append one step to PLAN_STEPS.
plan_step() {
  json_str "$2"
  PLAN_STEPS="$PLAN_STEPS${PLAN_STEPS:+,}{\"id\":\"$1\",\"label\":$JSON_STR,\"est_s\":null}"
}

# read_decision: DECISION = the window's answer to a failed step, read from the
# control fd — retry or quit. The window closing (EOF) is quit.
read_decision() {
  local line
  DECISION=quit
  while IFS= read -r -u "$CTL_FD" line; do
    case "$line" in
      retry|quit) DECISION=$line; return 0 ;;
      *) echo "install.sh: ignored an unknown decision from the window: $line" >&2 ;;
    esac
  done
  return 0
}

# run_step <id> <command…>: one top-level step. Emits its start, its output as
# log lines, then done or failed with how long it ran. In the window, a failed
# step waits for a decision: retry runs it again (every step checks before it
# acts), quit gives up. Without a window the command runs with its output on
# the terminal, as it always has.
#
# Its status is STEP_RC, and run_step itself always returns 0: NEVER call it
# as a condition (`run_step … || fail`, `if run_step …`). There bash ignores
# `set -e` for everything the call runs — the step's subshell included, even
# though it sets -e again — so a command failing in the middle of a step body
# would no longer end the step (apt-get failing, then the next line passing:
# the step would read as done). Called as a plain statement, the body runs
# under -e. The --dry-run stream test fails a step mid-body to hold this.
run_step() {
  local id=$1 t0
  shift
  STEP_ATTEMPT=0
  while :; do
    STEP_ATTEMPT=$((STEP_ATTEMPT + 1))
    ev_step "$id" start
    t0=$SECONDS
    set +e
    if [ -n "$EV_FD" ]; then
      ( eval "exec $CLOSE_FDS"; set -e; "$@" ) 2>&1 | ev_lines "$id"
      STEP_RC=${PIPESTATUS[0]}
    else
      ( set -e; "$@" )
      STEP_RC=$?
    fi
    set -e
    if [ "$STEP_RC" = "0" ]; then
      ev_step "$id" done "$(((SECONDS - t0) * 1000))"
      return 0
    fi
    ev_step "$id" failed "$(((SECONDS - t0) * 1000))"
    [ -n "$CTL_FD" ] || return 0
    read_decision
    [ "$DECISION" = "retry" ] || return 0
  done
}

# ── --dry-run ────────────────────────────────────────────────────────────────
# The event stream of a scripted install, touching nothing: every event type,
# a skipped step, and output that needs escaping. EQUIN_INSTALL_DRY_RUN_PACE
# (seconds between lines, default 0) slows it down for watching the window;
# EQUIN_INSTALL_DRY_RUN_FAIL=<step id> fails that step's first attempt, so a
# retry decision on the control fd can be exercised.

dry_step() {
  local pace="${EQUIN_INSTALL_DRY_RUN_PACE:-0}" i
  for i in 1 2 3; do
    echo "$1: working ($i of 3)"
    [ "$pace" = "0" ] || sleep "$pace"
  done
  if [ "$1" = "toolchain" ]; then
    printf '%s\n' 'quotes "x", a backslash \ and a tab:	done' \
      $'\033[32mcolour\033[0m codes' 'unicode: é ✓ 漢字'
    printf 'no trailing newline'
    echo >&2
    echo "this line went to stderr" >&2
  fi
  if [ "$1" = "${EQUIN_INSTALL_DRY_RUN_FAIL:-}" ] && [ "$STEP_ATTEMPT" = "1" ]; then
    echo "$1: failed (dry run, first attempt)" >&2
    false # mid-body: only `set -e` ends the step here (see run_step)
  fi
  echo "$1: finished"
}

dry_run() {
  echo "  equin installer (dry run: nothing on this machine is changed)"
  ev_plan "Download equin"
  ev_step tools skipped
  local id
  for id in mise clone toolchain start build; do
    run_step "$id" dry_step "$id"
    [ "$STEP_RC" = "0" ] || fail "The $id step of the dry run failed." "dry run, $id"
  done
  ev done "\"url\":\"$APP_URL\",\"ms\":$((SECONDS * 1000))"
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
