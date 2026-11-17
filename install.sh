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
# Every run keeps its events in ~/.equin/logs/install/<run>/events.jsonl
# (`latest` links to the newest run). Without a window, the terminal draws
# them: a status block redrawn in place on a terminal, timestamped lines
# otherwise (CI, a pipe, TERM=dumb).
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
    elif [ "$OS" != Darwin ] && [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
      # Every desktop session has one; without it the window's web view
      # stalls ~30 s on D-Bus timeouts (found in release CI) — past --probe's
      # deadline, so skip the wait.
      VIEW_WHY="there is no desktop session to show a window in"
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
  plan_data "$( [ -n "$SELF_DIR" ] && echo "Use your copy of equin" || echo "Download equin" )"
  start_hub
  ev_plan

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
  ev_done
  # Without a window the terminal view draws the same in its done state.
  if [ "$MODE" = "window" ]; then
    say "equin is running: $APP_URL"
    echo "  equin's code is in $INSTALL_DIR"
    if [ "$EDIT_RC" = "1" ]; then
      echo "  Open a new terminal to use ./equin there (new terminals find its tools)."
    fi
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
  sudo_once
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
    step_ev "\"type\":\"wait\",\"step\":\"tools\",\"state\":\"start\",\"on\":\"apple-installer\""
    until xcode-select -p >/dev/null 2>&1; do sleep 5; done
    step_ev "\"type\":\"wait\",\"step\":\"tools\",\"state\":\"end\",\"on\":\"apple-installer\""
  fi
}

# sudo_once: ask for the password now, as a wait the terminal view stops
# redrawing for (the prompt is on the terminal, below its status block); the
# step's later sudo calls reuse it.
sudo_once() {
  if sudo -n true 2>/dev/null; then return 0; fi
  step_ev "\"type\":\"wait\",\"step\":\"$EQUIN_INSTALL_STEP\",\"state\":\"start\",\"on\":\"password\""
  sudo -v
  step_ev "\"type\":\"wait\",\"step\":\"$EQUIN_INSTALL_STEP\",\"state\":\"end\",\"on\":\"password\""
}

# prepare_linux <" pkg pkg…" or ""> <linger: 1 already on, 0 to enable>
prepare_linux() {
  sudo_once
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
  # --progress: git prints its percentages to a pipe too (the clone step's
  # reader, ev_frames, turns them into progress events).
  git clone --progress "$REPO_URL" "$INSTALL_DIR"
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
# object per line. The --dry-run stream test (plugins/installer/plugins/window/
# cli) parses this emitter's output against the schema, so the two cannot drift.
#
# Every event goes through ONE hub (start_hub): a FIFO in this run's dir,
# ~/.equin/logs/install/<run>/events.fifo, read by a background process that
# appends each line to events.jsonl beside it and hands it on — to the
# window's fd (--events-fd), else to the terminal view (render). Its writers:
#   - this script (`ev`), on a write end it keeps open for its whole life;
#   - the `./equin` commands it runs as steps (installer/cli
#     emitInstallEvent), which open the FIFO BY PATH, named by
#     EQUIN_INSTALL_EVENTS, and file what they report under EQUIN_INSTALL_STEP
#     (both exported into a step's subshell only). A step's commands never
#     inherit an fd of the stream (CLOSE_FDS): a daemon one of them starts must
#     not hold it open after the install has ended.
# Every event is one write under PIPE_BUF (512 bytes), so concurrent writers
# never interleave (the plan, written before any other writer exists, is the
# one exception). The hub sees EOF once every writer is gone; the EXIT trap
# (on_exit) writes `exit`, closes this script's write end and waits for the
# hub to drain, so `exit` is always the last line a reader sees.

APP_URL="http://equin.localhost:9000"
EV_FD=""
CTL_FD=""
EV_OUT=""
EV_T=""
EV_T_AT=-1
STEP_ATTEMPT=0
STEP_RC=0
MODE=""
HUB_PID=""
HUB_FD=""
RUN_DIR=""
FIFO=""
DONE_SENT=0
FAIL_MSG=""
FAIL_DETAILS=""

# BEGIN estimates — generated by `./equin installer estimates` from plugins/installer/core/estimates.json; do not edit
est_s() {
  case "$1" in
    tools) echo null ;;
    mise) echo null ;;
    clone) echo null ;;
    toolchain) echo null ;;
    start) echo null ;;
    build) echo null ;;
    build.database) echo null ;;
    build.deps) echo null ;;
    build.codegen) echo null ;;
    build.interface) echo null ;;
    build.deploy) echo null ;;
    *) echo "install.sh: no estimate entry for step '$1'" >&2; exit 2 ;;
  esac
}
# END estimates

# Check the fds the window handed over, pick how the install is drawn (MODE)
# and set the traps that end the stream.
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
  if [ -n "$EV_FD" ]; then
    MODE=window
  elif [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ -z "${CI:-}" ]; then
    MODE=interactive
  else
    MODE=plain
  fi
  # Until the hub runs, the only event (exit, from an early refusal) goes
  # straight to the window.
  EV_OUT="$EV_FD"
  # A step's commands never see the window's fds (nor, once it runs, the
  # hub's write end — start_hub adds it).
  CLOSE_FDS=""
  [ -n "$EV_FD" ] && CLOSE_FDS="$EV_FD>&-"
  [ -n "$CTL_FD" ] && CLOSE_FDS="$CLOSE_FDS $CTL_FD<&-"
  trap on_exit EXIT
  # Stopped (the window's Stop, Ctrl-C): exit with the shell's status for the
  # signal, so the exit event says so. Without these, bash runs the EXIT trap
  # with $? = 0 before dying of the signal, and a decision read interrupted by
  # one would be taken as quit.
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  return 0
}

# The EXIT trap: the exit event, then the hub drained (the terminal view draws
# its last frame), timing.json after a success, and only then a failure's
# message — below the terminal view's last frame, never under its redraws.
on_exit() {
  local rc=$?
  set +e
  if [ -n "$HUB_PID" ]; then
    ev exit "\"code\":$rc"
    eval "exec $HUB_FD>&-"
    EV_OUT=""
    wait "$HUB_PID"
    rm -f "$FIFO"
    [ "$DONE_SENT" = "1" ] && write_timing
  else
    ev exit "\"code\":$rc"
  fi
  if [ -n "$FAIL_MSG" ]; then
    print_fail "$FAIL_MSG" "$FAIL_DETAILS"
  fi
  exit "$rc"
}

# The first fd from 9 down the window did not hand over.
free_fd() {
  local fd
  for fd in 9 8 7 6 5; do
    if [ "$fd" != "$EV_FD" ] && [ "$fd" != "$CTL_FD" ]; then
      HUB_FD=$fd
      return 0
    fi
  done
}

# start_hub: this run's dir and FIFO, the hub reading it, and this script's
# write end (HUB_FD). Needs plan_data first (the terminal view draws its rows).
start_hub() {
  local root run_id
  root="$(data_root)/logs/install"
  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  RUN_DIR="$root/$run_id"
  FIFO="$RUN_DIR/events.fifo"
  mkdir -p "$RUN_DIR"
  mkfifo -m 600 "$FIFO"
  ln -sfn "$run_id" "$root/latest"
  free_fd
  # The hub ignores the signals that stop the install: it drains what the
  # writers wrote and ends at EOF, after the exit event.
  if [ "$MODE" = "window" ]; then
    (
      trap '' INT TERM HUP
      [ -z "$CTL_FD" ] || eval "exec $CTL_FD<&-"
      exec tee -a "$RUN_DIR/events.jsonl" <"$FIFO" >&"$EV_FD"
    ) &
  else
    ( trap '' INT TERM HUP; tee -a "$RUN_DIR/events.jsonl" <"$FIFO" | render ) &
  fi
  HUB_PID=$!
  # Blocks until the hub has the read end open.
  eval "exec $HUB_FD>\"\$FIFO\""
  EV_OUT=$HUB_FD
  CLOSE_FDS="$CLOSE_FDS $HUB_FD>&-"
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

# byte_len <text>: BYTE_LEN = its length in bytes, whatever the locale.
byte_len() {
  local LC_ALL=C
  BYTE_LEN=${#1}
}

# ev <type> [<fields, without braces>]: write one event.
ev() {
  [ -n "$EV_OUT" ] || return 0
  ev_now
  printf '{"v":1,"t":"%s","type":"%s"%s}\n' "$EV_T" "$1" "${2:+,$2}" >&"$EV_OUT"
}

# ev_step <id> <start|done|skipped|failed> [ms]
ev_step() {
  ev step "\"id\":\"$1\",\"state\":\"$2\"${3:+,\"ms\":$3}"
}

ev_done() {
  ev done "\"url\":\"$APP_URL\",\"ms\":$((SECONDS * 1000))"
  DONE_SENT=1
}

# step_ev <fields, without braces>: an event from inside a step, written the
# way a `./equin` command writes its own (installer/cli emitInstallEvent):
# the FIFO opened by path, one write. A no-op outside an install's step.
step_ev() {
  [ -n "${EQUIN_INSTALL_EVENTS:-}" ] || return 0
  printf '{"v":1,"t":"%s",%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" > "$EQUIN_INSTALL_EVENTS"
}

# log_line <step id> <text>: one log event. The line is cut so the whole event
# stays one write under PIPE_BUF (its JSON at most 400 bytes): a longer line is
# kept only in part here — events.jsonl is the install's record, and a line
# that long is not one a person reads in the view.
log_line() {
  local text=$2 n=380
  if [ "${#text}" -le 60 ]; then
    json_str "$text" # 60 characters escape to at most 362 bytes
  else
    while :; do
      json_str "${text:0:$n}"
      byte_len "$JSON_STR"
      [ "$BYTE_LEN" -gt 400 ] || break
      n=$((n * 390 / BYTE_LEN)) # in proportion: always fewer characters
    done
  fi
  local step=null
  [ -z "$1" ] || step="\"$1\""
  ev log "\"step\":$step,\"stream\":\"out\",\"line\":$JSON_STR"
}

# ev_lines <step id>: each line of stdin, as a log event of that step.
ev_lines() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    log_line "$1" "$line"
  done
}

# ev_frames <step id>: ev_lines for a tool that redraws a progress line with
# CR (git, softwareupdate). Read a character at a time (their output is
# small), so a frame is seen as it is drawn: its percentage becomes a progress
# event when it changes, and only the last frame of each phase ("Receiving
# objects: 100% …, done.") is kept as a log line, never every redraw.
ev_frames() {
  local c buf=""
  FR_HELD=""
  FR_LAST=-1
  while :; do
    c=""
    IFS= read -r -d '' -n 1 c || [ -n "$c" ] || break
    case "$c" in
      $'\r') frame_out "$1" "$buf" cr; buf="" ;;
      $'\n') frame_out "$1" "$buf" nl; buf="" ;;
      *) buf="$buf$c" ;;
    esac
  done
  [ -z "$buf" ] || frame_out "$1" "$buf" nl
  [ -z "$FR_HELD" ] || log_line "$1" "$FR_HELD"
  return 0
}

# frame_out <step id> <text> <cr|nl>: a frame (cr) replaces the held one of the
# same phase (the text before its first colon); a line (nl) ends it.
frame_out() {
  frame_progress "$1" "$2"
  if [ "$3" = "cr" ]; then
    [ -n "$2" ] || return 0
    if [ -n "$FR_HELD" ] && [ "${FR_HELD%%:*}" != "${2%%:*}" ]; then
      log_line "$1" "$FR_HELD"
    fi
    FR_HELD=$2
    return 0
  fi
  if [ -z "$2" ] && [ -n "$FR_HELD" ]; then # CR LF: the held frame was a line
    log_line "$1" "$FR_HELD"
    FR_HELD=""
    return 0
  fi
  if [ -n "$FR_HELD" ] && [ "${FR_HELD%%:*}" != "${2%%:*}" ]; then
    log_line "$1" "$FR_HELD"
  fi
  FR_HELD=""
  log_line "$1" "$2"
}

# frame_progress <step id> <text>: the step's percentage, if the text has one.
# git: `Receiving objects:  45% (450/1000), …` (only that phase counts).
# softwareupdate: `Downloading Command Line Tools…: 45.00%`, then
# `Installing …: 90.00%` — downloading is the first half, installing the second.
frame_progress() {
  local re='([0-9]+)(\.[0-9]+)?%' p
  [ "$1" != "clone" ] || re='Receiving objects: *([0-9]+)%'
  [[ $2 =~ $re ]] || return 0
  p=$((10#${BASH_REMATCH[1]}))
  if [ "$1" = "tools" ]; then
    case "$2" in
      *nstall*) p=$((50 + p / 2)) ;;
      *ownload*) p=$((p / 2)) ;;
    esac
  fi
  [ "$p" -le 100 ] || return 0
  [ "$p" != "$FR_LAST" ] || return 0
  FR_LAST=$p
  ev progress "\"id\":\"$1\",\"done\":$p,\"total\":100,\"unit\":\"%\""
}

# plan_data <label of the clone step>: the plan, as the arrays both the plan
# event and the terminal view read — groups (G_*) and steps (P_*: top-level
# steps, then each sub-step after its parent). P_EST is the step's measured
# median in seconds (est_s, generated from core/estimates.json), empty when
# there is none: a step without one shows no number, never a made-up one.
plan_data() {
  local prep="Prepare your Mac" tools_doing="Installing Apple's developer tools"
  if [ "$OS" != "Darwin" ]; then
    prep="Prepare your system"
    tools_doing="Installing what equin needs from your system"
  fi
  PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
  if [ "$OS" = "Darwin" ]; then
    SYS_DESC="macOS $(sw_vers -productVersion 2>/dev/null || true) $(uname -m)"
  else
    SYS_DESC="$(uname -s) $(uname -m)"
  fi
  G_ID=(prepare download tools services build)
  G_LABEL=("$prep" "$1" "Install tools" "Start services" "Build equin")
  P_N=0
  plan_add tools "" prepare "$prep" "$tools_doing"
  plan_add mise "" prepare "Install the tool manager" "Installing the tool manager"
  plan_add clone "" download "$1" "Downloading equin"
  plan_add toolchain "" tools "Install Bun, Go and Rust" "Installing Bun, Go and Rust"
  plan_add start "" services "Start equin's services" "Starting equin's services"
  plan_add build "" build "Build equin" "Building equin"
  plan_add build.database build build "Prepare the database" "Preparing the database"
  plan_add build.deps build build "Install dependencies" "Installing dependencies"
  plan_add build.codegen build build "Generate code" "Generating code"
  plan_add build.interface build build "Build the interface" "Building the interface"
  plan_add build.deploy build build "Start equin" "Starting equin"
}

# plan_add <id> <parent id or ""> <group> <label> <doing>
plan_add() {
  local est
  est="$(est_s "$1")"
  [ "$est" != "null" ] || est=""
  P_ID[P_N]=$1
  P_PARENT[P_N]=$2
  P_GROUP[P_N]=$3
  P_LABEL[P_N]=$4
  P_DOING[P_N]=$5
  P_EST[P_N]=$est
  P_LC[P_N]="$(printf '%s' "$4" | tr '[:upper:]' '[:lower:]')"
  P_N=$((P_N + 1))
}

# ev_plan: the plan event, from plan_data's arrays.
ev_plan() {
  local groups="" steps="" subs i j
  for ((i = 0; i < ${#G_ID[@]}; i++)); do
    json_str "${G_LABEL[i]}"
    groups="$groups${groups:+,}{\"id\":\"${G_ID[i]}\",\"label\":$JSON_STR}"
  done
  for ((i = 0; i < P_N; i++)); do
    [ -z "${P_PARENT[i]}" ] || continue
    subs=""
    for ((j = 0; j < P_N; j++)); do
      [ "${P_PARENT[j]}" = "${P_ID[i]}" ] || continue
      subs="$subs${subs:+,}$(plan_json "$j")"
    done
    steps="$steps${steps:+,}$(plan_json "$i")"
    [ -z "$subs" ] || steps="${steps%\}},\"substeps\":[$subs]}"
  done
  local release=null
  [ -z "$RELEASE" ] || release="\"$RELEASE\""
  ev plan "\"release\":$release,\"platform\":\"$PLATFORM\",\"mode\":\"$MODE\",\"groups\":[$groups],\"steps\":[$steps]"
}

# plan_json <index>: one step of the plan, as JSON (a sub-step has no group).
plan_json() {
  local label doing
  json_str "${P_LABEL[$1]}"; label=$JSON_STR
  json_str "${P_DOING[$1]}"; doing=$JSON_STR
  printf '{"id":"%s","label":%s,"doing":%s' "${P_ID[$1]}" "$label" "$doing"
  [ -n "${P_PARENT[$1]}" ] || printf ',"group":"%s"' "${P_GROUP[$1]}"
  printf ',"est_s":%s}' "${P_EST[$1]:-null}"
}

# write_timing: <run dir>/timing.json (installer/core InstallTiming) — how long
# every step that ran to done took, read back from events.jsonl (this
# script's step events and the `./equin` commands' share one shape:
# {"v":1,"t":…,"type":"step","id":…,"state":"done","ms":…}). A step done twice
# (a retry) keeps its last time. `./equin installer estimates` takes the
# medians over these files.
write_timing() {
  local steps dry=false
  [ "$DRY_RUN" != "1" ] || dry=true
  steps="$(sed -n 's/^{"v":1,"t":"[^"]*","type":"step","id":"\([^"]*\)","state":"done","ms":\([0-9]*\)}$/\1 \2/p' "$RUN_DIR/events.jsonl" |
    awk '{ if (!($1 in ms)) order[n++] = $1; ms[$1] = $2 }
      END { for (i = 0; i < n; i++) printf "%s\"%s\":%s", (i ? "," : ""), order[i], ms[order[i]] }')"
  printf '{"v":1,"dryRun":%s,"release":null,"platform":"%s","at":"%s","steps":{%s}}\n' \
    "$dry" "$PLATFORM" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$steps" >"$RUN_DIR/timing.json"
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
# acts), quit gives up. The command's own `./equin` reports (sub-steps,
# progress, waits) reach the hub through EQUIN_INSTALL_EVENTS.
#
# Its status is STEP_RC, and run_step itself always returns 0: NEVER call it
# as a condition (`run_step … || fail`, `if run_step …`). There bash ignores
# `set -e` for everything the call runs — the step's subshell included, even
# though it sets -e again — so a command failing in the middle of a step body
# would no longer end the step (apt-get failing, then the next line passing:
# the step would read as done). Called as a plain statement, the body runs
# under -e. The --dry-run stream test fails a step mid-body to hold this.
run_step() {
  local id=$1 t0 reader=ev_lines
  shift
  case "$id" in clone|tools) reader=ev_frames ;; esac
  STEP_ATTEMPT=0
  while :; do
    STEP_ATTEMPT=$((STEP_ATTEMPT + 1))
    ev_step "$id" start
    t0=$SECONDS
    set +e
    (
      eval "exec $CLOSE_FDS"
      export EQUIN_INSTALL_EVENTS="$FIFO" EQUIN_INSTALL_STEP="$id"
      set -e
      "$@"
    ) 2>&1 | "$reader" "$id"
    STEP_RC=${PIPESTATUS[0]}
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

# ── The terminal view ────────────────────────────────────────────────────────
# What the hub draws when no window does (MODE interactive or plain), from the
# events alone plus the plan's arrays it inherited (plan_data) — the same
# stream the window draws, after the approved mockup's terminal view
# (proto-1794832268-wlybzk). Bash 3.2, no fork per event.
#
# Time: the only estimates are the plan's measured medians. Time left = the
# estimates of the steps not finished (the running one less what it has run,
# never below 0), times this machine's pace (actual / estimated over the
# steps finished so far, 1 before any). A remaining step without an estimate
# means no time left is shown at all ("step n of N"). A wait is shown as one
# and not counted down.

R_SPIN=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)

render() {
  set +eu
  shopt -s extglob
  local line tick=$'\001'
  r_init
  while :; do
    line=$tick
    # A 1 s timeout (bash 3.2 takes whole seconds) ticks the spinner and the
    # clocks; a timeout leaves the variable as it was, EOF empties it.
    if IFS= read -r -t 1 line; then
      r_event "$line"
    elif [ "$line" != "$tick" ]; then
      [ -z "$line" ] || r_event "$line"
      break
    fi
    [ "$MODE" != "interactive" ] || r_maybe_draw
  done
  r_finish
}

r_init() {
  local i probe='✓' sod
  # Widths are counted in characters: make sure the locale reads UTF-8.
  if [ "${#probe}" != "1" ]; then
    for LC_CTYPE in C.UTF-8 en_US.UTF-8 UTF-8; do
      [ "${#probe}" != "1" ] || break
    done
  fi
  for ((i = 0; i < P_N; i++)); do
    S_ST[i]=pending; S_T0[i]=0; S_MS[i]=0; S_PD[i]=""; S_PT[i]=""; S_PU[i]=""
    S_Q[i]=0; S_WON[i]=""; S_WKIND[i]=""; S_WAT[i]=""; S_WT0[i]=0; S_WSUM[i]=0
  done
  G_N=${#G_ID[@]}
  R_LOGS=(); R_LOGN=0; R_STEP_LOG0=0
  R_LAST_DRAW=-1; R_FORCE=0; R_H=0; R_TICK=0; R_PAUSED=0; R_STARTED=0
  R_DONE_URL=""; R_DONE_MS=""; R_EXIT=""; R_ENDED=0
  r_tilde "$(data_root)"; R_DATA=$TL
  R_LOGPATH="$R_DATA/logs/install/latest/events.jsonl"
  r_tilde "$INSTALL_DIR"; R_DIR=$TL
  R_COLS=""
  if [ "$MODE" = "interactive" ]; then
    R_COLS=$(stty size 2>/dev/null </dev/tty) && R_COLS=${R_COLS#* }
  fi
  case "$R_COLS" in '' | 0 | *[!0-9]*) R_COLS=${COLUMNS:-80} ;; esac
  r_epoch "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; R_EP0=$((EP - SECONDS))
  sod=$(date +%H:%M:%S)
  R_SOD0=$((10#${sod:0:2} * 3600 + 10#${sod:3:2} * 60 + 10#${sod:6:2} - SECONDS))
  if [ "$MODE" = "interactive" ]; then
    C_B=$'\033[1m' C_D=$'\033[2m' C_G=$'\033[32m' C_R=$'\033[31m' C_Y=$'\033[33m' C_A=$'\033[36m' C_0=$'\033[0m'
  else
    C_B="" C_D="" C_G="" C_R="" C_Y="" C_A="" C_0=""
  fi
}

r_tilde() { TL=$1; [ "${TL#"$HOME"}" = "$TL" ] || TL="~${TL#"$HOME"}"; }

# ── Reading an event (field extraction by pattern: the events are flat
# objects whose ids and enums never hold a quote) ──
r_str() { local v=${2#*\"$1\":\"}; if [ "$v" = "$2" ]; then F=""; return 1; fi; F=${v%%\"*}; }
r_num() { local v=${2#*\"$1\":}; if [ "$v" = "$2" ]; then F=""; return 1; fi; F=${v%%[,\}]*}; [ "$F" != "null" ] || F=""; }
r_idx() { local i; RI=-1; for ((i = 0; i < P_N; i++)); do if [ "${P_ID[i]}" = "$1" ]; then RI=$i; return 0; fi; done; }

r_event() {
  local l=$1 type id state ms d t unit on kind at
  r_str type "$l"; type=$F
  case "$type" in
    plan) [ "$MODE" != "plain" ] || r_plain_header; R_STARTED=1 ;;
    step)
      r_str id "$l"; id=$F; r_str state "$l"; state=$F; r_num ms "$l"; ms=$F
      r_on_step "$id" "$state" "$ms" ;;
    progress)
      r_str id "$l"; id=$F; r_num done "$l"; d=$F; r_num total "$l"; t=$F; r_str unit "$l"; unit=$F
      r_on_progress "$id" "$d" "$t" "$unit" ;;
    wait)
      r_str step "$l"; id=$F; r_str state "$l"; state=$F; r_str on "$l"; on=$F
      r_str kind "$l"; kind=$F; r_str startedAt "$l"; at=$F; r_str t "$l"; t=$F
      r_on_wait "$id" "$state" "$on" "$kind" "$at" "$t" ;;
    log) r_on_log "$l" ;;
    done)
      r_num ms "$l"; R_DONE_MS=$F; r_str url "$l"; R_DONE_URL=$F; R_FORCE=1
      if [ "$MODE" = "plain" ]; then
        r_fmt $((R_DONE_MS / 1000)); r_plain "equin is ready · installed in $FM · $R_DONE_URL"
      fi ;;
    exit) r_num code "$l"; R_EXIT=$F ;;
  esac
}

r_is_leaf() { [ -n "${P_PARENT[$1]}" ] || [ "${P_ID[$1]}" != "build" ]; }
r_group_n() { local j; GN=0; for ((j = 0; j < G_N; j++)); do if [ "${G_ID[j]}" = "$1" ]; then GN=$((j + 1)); return 0; fi; done; }
r_name() { if [ -n "${P_PARENT[$1]}" ]; then NM="build › ${P_LC[$1]}"; else NM=${P_LC[$1]}; fi; r_group_n "${P_GROUP[$1]}"; NM="[$GN/$G_N] $NM"; }

r_on_step() {
  local i j
  r_idx "$1"; i=$RI
  [ "$i" -ge 0 ] || return 0
  R_FORCE=1
  case "$2" in
    start)
      S_ST[i]=active; S_T0[i]=$SECONDS; S_WSUM[i]=0; S_WON[i]=""; S_PD[i]=""; S_PT[i]=""; S_Q[i]=0
      [ -n "${P_PARENT[i]}" ] || R_STEP_LOG0=$R_LOGN # a failure shows its own step's lines
      if [ "$1" = "build" ]; then # a retry starts the sub-steps over
        for ((j = 0; j < P_N; j++)); do [ "${P_PARENT[j]}" != "build" ] || S_ST[j]=pending; done
      fi
      if [ "$MODE" = "plain" ]; then
        r_name "$i"
        if [ -n "${P_EST[i]}" ]; then r_approx "${P_EST[i]}"; r_plain "$NM: started (usually ${AP#\~})"
        else r_plain "$NM: started"; fi
      fi ;;
    done | failed)
      r_wait_close "$i"
      S_ST[i]=$2
      S_MS[i]=${3:-$(((SECONDS - S_T0[i]) * 1000))}
      if [ "$1" = "build" ]; then # what the build left open ends with it
        for ((j = 0; j < P_N; j++)); do
          [ "${P_PARENT[j]}" = "build" ] || continue
          case "${S_ST[j]}" in
            active) S_ST[j]=$2; S_MS[j]=$(((SECONDS - S_T0[j]) * 1000)) ;;
            pending) [ "$2" = "failed" ] || S_ST[j]=skipped ;;
          esac
        done
      fi
      if [ "$MODE" = "plain" ]; then
        r_name "$i"; r_fmt $((S_MS[i] / 1000))
        if [ "$2" = "done" ]; then
          r_plain "$NM: done in $FM"
        else
          r_plain "$NM: failed after $FM"
          [ -n "${P_PARENT[i]}" ] || r_tail "  > "
        fi
      fi ;;
    skipped)
      S_ST[i]=skipped
      if [ "$MODE" = "plain" ]; then
        r_name "$i"
        if [ -n "${P_PARENT[i]}" ]; then r_plain "$NM: nothing to do"; else r_plain "$NM: already installed"; fi
      fi ;;
  esac
}

r_on_progress() {
  local i q pct
  r_idx "$1"; i=$RI
  [ "$i" -ge 0 ] || return 0
  S_PD[i]=$2; S_PT[i]=$3; S_PU[i]=$4
  [ "$MODE" = "plain" ] || return 0
  [ -n "$3" ] && [ "$3" -gt 0 ] || return 0
  q=$(($2 * 4 / $3))
  [ "$q" -gt "${S_Q[i]}" ] && [ "$q" -lt 4 ] || return 0
  S_Q[i]=$q
  pct=$(($2 * 100 / $3))
  r_name "$i"
  local text="$NM: $pct%"
  [ "$4" = "%" ] || text="$text ($2/$3 $4)"
  r_remaining
  if [ -n "$REM" ]; then r_left "$REM"; text="$text · $LF"; fi
  r_plain "$text"
}

r_on_wait() {
  local i
  r_idx "$1"; i=$RI
  [ "$i" -ge 0 ] || return 0
  R_FORCE=1
  if [ "$2" = "start" ]; then
    S_WON[i]=$3; S_WT0[i]=$SECONDS; S_WKIND[i]=$4; S_WAT[i]=$5
    r_wait_text "$i"
    if [ "$MODE" = "plain" ]; then r_name "$i"; r_plain "$NM: $WT"; fi
    if [ "$MODE" = "interactive" ] && [ "$3" = "password" ]; then
      # The prompt is printed below the block: stop redrawing over it.
      r_draw; R_PAUSED=1
    fi
  else
    local waited=$((SECONDS - S_WT0[i]))
    r_wait_close "$i"
    if [ "$MODE" = "plain" ]; then r_name "$i"; r_fmt "$waited"; r_plain "$NM: resumed after waiting $FM"; fi
    if [ "$R_PAUSED" = "1" ]; then R_PAUSED=0; R_H=0; fi
  fi
}

r_wait_close() {
  [ -n "${S_WON[$1]}" ] || return 0
  S_WSUM[$1]=$((S_WSUM[$1] + SECONDS - S_WT0[$1]))
  S_WON[$1]=""
}

# r_wait_text <i>: WT = the step's open wait, in the window's words
# (window/standalone-page/model.ts waitText) — no internal names. The
# holder's "started N min ago" is read against the clock now.
r_wait_text() {
  local on=${S_WON[$1]} kind=${S_WKIND[$1]} at=${S_WAT[$1]}
  if [ -n "$kind" ] && [ -n "$at" ]; then
    local ago
    r_epoch "$at"; ago=$((R_EP0 + SECONDS - EP)); [ "$ago" -ge 0 ] || ago=0
    if [ "$ago" -lt 60 ]; then ago="less than a minute ago"
    elif [ "$ago" -lt 3600 ]; then ago="$((ago / 60)) min ago"
    elif [ "$ago" -lt 7200 ]; then ago="1 hour ago"
    else ago="$((ago / 3600)) hours ago"; fi
    WT="Waiting for another task to finish · a $kind started $ago"
    return 0
  fi
  case "$on" in
    host-grant) WT="Waiting for other work on this Mac to finish…" ;;
    lock) WT="Waiting for another run of this step to finish…" ;;
    apple-installer) WT="Waiting for Apple's installer to finish…" ;;
    password) WT="Waiting for your password…" ;;
    *) WT="Waiting…" ;;
  esac
}

# r_epoch <ISO-8601 UTC>: EP = its Unix time (days-from-civil; no `date`,
# whose flags differ between macOS and Linux).
r_epoch() {
  local s=$1 y m d doy doe yoe era
  y=$((10#${s:0:4})); m=$((10#${s:5:2})); d=$((10#${s:8:2}))
  [ "$m" -gt 2 ] || y=$((y - 1))
  era=$((y / 400)); yoe=$((y - era * 400))
  doy=$(((153 * ((m + 9) % 12) + 2) / 5 + d - 1))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  EP=$(((era * 146097 + doe - 719468) * 86400 + 10#${s:11:2} * 3600 + 10#${s:14:2} * 60 + 10#${s:17:2}))
}

r_on_log() {
  local v
  v=${1#*\"line\":\"}; v=${v%\"\}}
  v=${v//\\u001b\[*([0-9;?])[a-zA-Z]/}
  v=${v//\\u001b/}
  v=${v//\\t/ }
  v=${v//\\r/}
  v=${v//\\\"/\"}
  v=${v//\\\\/\\}
  [ -n "${v//[[:space:]]/}" ] || return 0
  R_LOGS[R_LOGN % 15]=$v
  R_LOGN=$((R_LOGN + 1))
}

# r_tail <prefix>: the last 15 log lines (what a failure's message points at).
r_tail() {
  local k start=$R_STEP_LOG0
  [ "$start" -ge $((R_LOGN - 15)) ] || start=$((R_LOGN - 15))
  for ((k = start; k < R_LOGN; k++)); do
    if [ "$MODE" = "plain" ]; then printf '%s\n' "$1${R_LOGS[k % 15]}"
    else r_ln "${C_D}$1$(r_cut "${R_LOGS[k % 15]}" $((R_COLS - 6)))${C_0}"; fi
  done
}

# ── Time ──
r_fmt() { local s=$1; if [ "$s" -lt 60 ]; then FM="${s}s"; elif [ $((s % 60)) = 0 ]; then FM="$((s / 60))m"; else FM="$((s / 60))m $(printf %02d $((s % 60)))s"; fi; }
r_approx() { local s=$1; if [ "$s" -lt 45 ]; then s=$(((s + 2) / 5 * 5)); [ "$s" -ge 5 ] || s=5; AP="~${s}s"; else s=$(((s + 30) / 60)); [ "$s" -ge 1 ] || s=1; AP="~$s min"; fi; }
r_left() { if [ "$1" -lt 50 ]; then LF="less than a minute left"; else LF="about $((($1 + 30) / 60)) min left"; fi; }

# r_elapsed <i>: E = how long the running step has worked, its waits left out.
r_elapsed() {
  E=$((SECONDS - S_T0[$1] - S_WSUM[$1]))
  [ -z "${S_WON[$1]}" ] || E=$((E - SECONDS + S_WT0[$1]))
  [ "$E" -ge 0 ] || E=0
}

# r_worked <i>: WKD = seconds the step worked (finished: its ms less its
# waits; running: so far; else 0).
r_worked() {
  case "${S_ST[$1]}" in
    active) r_elapsed "$1"; WKD=$E ;;
    done | failed) WKD=$((S_MS[$1] / 1000 - S_WSUM[$1])); [ "$WKD" -ge 0 ] || WKD=0 ;;
    *) WKD=0 ;;
  esac
}

# r_pace: PACE_A / PACE_E = worked / estimated seconds over the finished steps
# that had an estimate (1/1 before any).
r_pace() {
  local i
  PACE_A=0; PACE_E=0
  for ((i = 0; i < P_N; i++)); do
    r_is_leaf "$i" || continue
    [ "${S_ST[i]}" = "done" ] && [ -n "${P_EST[i]}" ] || continue
    r_worked "$i"
    PACE_A=$((PACE_A + WKD)); PACE_E=$((PACE_E + P_EST[i]))
  done
  if [ "$PACE_E" -le 0 ]; then PACE_A=1; PACE_E=1; fi
}

# r_remaining [group id]: REM = seconds left (Σ pending est × pace, plus the
# running one's max(0, est × pace − worked)), empty when a step left has no
# estimate; WK = seconds worked so far. The same math as the window's page
# (window/standalone-page/model.ts), so both say the same.
r_remaining() {
  local i sum=0 x
  REM=""; WK=0
  r_pace
  for ((i = 0; i < P_N; i++)); do
    r_is_leaf "$i" || continue
    [ -z "${1:-}" ] || [ "${P_GROUP[i]}" = "$1" ] || continue
    [ "${S_ST[i]}" = "skipped" ] || { r_worked "$i"; WK=$((WK + WKD)); }
  done
  for ((i = 0; i < P_N; i++)); do
    r_is_leaf "$i" || continue
    [ -z "${1:-}" ] || [ "${P_GROUP[i]}" = "$1" ] || continue
    case "${S_ST[i]}" in
      done | skipped) continue ;;
    esac
    [ -n "${P_EST[i]}" ] || return 0
    x=$((P_EST[i] * PACE_A / PACE_E))
    if [ "${S_ST[i]}" = "active" ]; then
      r_elapsed "$i"
      [ "$E" -ge "$x" ] || sum=$((sum + x - E))
    else
      sum=$((sum + x))
    fi
  done
  REM=$sum
}

# r_progress [group id]: PCT = how far the install (or one group) is, in
# percent. With every step left estimated: worked / (worked + remaining).
# Otherwise by finished steps, a step's finished sub-steps counting as
# fractions of it (the window's rule); for a group, by its running step's own
# count when the tool gave one, else empty (no bar).
r_progress() {
  local i j n=0 sum=0 subs fin
  PCT=""
  r_remaining "${1:-}"
  if [ -n "$REM" ]; then
    if [ $((WK + REM)) -gt 0 ]; then PCT=$((WK * 100 / (WK + REM))); else PCT=0; fi
    return 0
  fi
  if [ -n "${1:-}" ]; then
    # (finished steps + the running one's own count) / steps; a lone step
    # without a count has no bar (its row says what it is doing instead).
    local counted=0
    for ((i = 0; i < P_N; i++)); do
      [ "${P_GROUP[i]}" = "$1" ] && r_is_leaf "$i" && [ "${S_ST[i]}" != "skipped" ] || continue
      n=$((n + 1))
      case "${S_ST[i]}" in
        done) sum=$((sum + 100)) ;;
        active)
          if [ -n "${S_PT[i]}" ] && [ "${S_PT[i]}" -gt 0 ]; then
            sum=$((sum + S_PD[i] * 100 / S_PT[i])); counted=1
          fi ;;
      esac
    done
    if [ "$n" -gt 1 ] || [ "$counted" = "1" ]; then PCT=$((sum / n)); fi
    return 0
  fi
  for ((i = 0; i < P_N; i++)); do
    [ -z "${P_PARENT[i]}" ] || continue
    n=$((n + 1))
    case "${S_ST[i]}" in
      done | skipped) sum=$((sum + 100)); continue ;;
    esac
    subs=0; fin=0
    for ((j = 0; j < P_N; j++)); do
      [ "${P_PARENT[j]}" = "${P_ID[i]}" ] || continue
      subs=$((subs + 1))
      case "${S_ST[j]}" in done | skipped) fin=$((fin + 1)) ;; esac
    done
    [ "$subs" = 0 ] || sum=$((sum + fin * 100 / subs))
  done
  [ "$n" = 0 ] || PCT=$((sum / n))
}

# ── Plain: append-only timestamped lines ──
r_plain() {
  local sod=$(((R_SOD0 + SECONDS) % 86400))
  printf '%02d:%02d:%02d %s\n' $((sod / 3600)) $((sod % 3600 / 60)) $((sod % 60)) "$1"
}

r_plain_header() {
  local i tot=0 all=1 text
  text="equin installer · $SYS_DESC · $R_DIR · plain output"
  [ "$DRY_RUN" != "1" ] || text="$text · dry run: nothing is changed"
  r_plain "$text"
  for ((i = 0; i < P_N; i++)); do
    r_is_leaf "$i" || continue
    if [ -n "${P_EST[i]}" ]; then tot=$((tot + P_EST[i])); else all=0; fi
  done
  text="plan: $G_N steps"
  if [ "$all" = "1" ]; then r_approx "$tot"; text="$text, about ${AP#\~}"; fi
  r_plain "$text · log $R_LOGPATH"
}

# ── Interactive: a status block redrawn in place ──
r_ln() { R_L[R_LN]=$1; R_LN=$((R_LN + 1)); }
# r_cut <text> <width>: at most that many characters.
r_cut() { local w=$2; [ "$w" -ge 4 ] || w=4; if [ "${#1}" -le "$w" ]; then printf '%s' "$1"; else printf '%s…' "${1:0:$((w - 1))}"; fi; }
r_pad() { printf -v PD "%-$2s" "$1"; }
r_padl() { printf -v PD "%$2s" "$1"; }
r_bar() { # <percent> <width>
  local n=$(($1 * $2 / 100)) a="" b=""
  [ "$n" -le "$2" ] || n=$2
  for ((k = 0; k < n; k++)); do a="${a}━"; done
  if [ "$n" -lt "$2" ]; then b="╺"; for ((k = n + 1; k < $2; k++)); do b="${b}━"; done; fi
  BAR="${C_A}$a${C_0}${C_D}$b${C_0}"
}

r_maybe_draw() {
  [ "$R_STARTED" = "1" ] && [ "$R_PAUSED" = "0" ] || return 0
  if [ "$R_FORCE" = "1" ] || [ "$SECONDS" != "$R_LAST_DRAW" ]; then r_draw; fi
}

r_mark() { # <state> <waiting?>
  case "$1" in
    done) MK="${C_G}✓${C_0}" ;;
    skipped) MK="${C_D}✓${C_0}" ;;
    failed) MK="${C_R}✗${C_0}" ;;
    active) if [ -n "$2" ]; then MK="${C_Y}◷${C_0}"; else MK="${C_A}${R_SPIN[R_TICK % 10]}${C_0}"; fi ;;
    *) MK="${C_D}·${C_0}" ;;
  esac
}

# r_group <j>: GS (the group's state), GA (its running leaf, or -1), GMS (ms
# its steps took), GEST (its leaves' estimate sum, empty if one has none).
r_group() {
  local i gid=${G_ID[$1]} n=0 sk=0 dn=0 pe=0 fl=0 ac=0
  GA=-1; GMS=0; GEST=0
  for ((i = 0; i < P_N; i++)); do
    [ "${P_GROUP[i]}" = "$gid" ] || continue
    if [ -z "${P_PARENT[i]}" ]; then
      n=$((n + 1))
      case "${S_ST[i]}" in
        skipped) sk=$((sk + 1)) ;;
        done) dn=$((dn + 1)); GMS=$((GMS + S_MS[i])) ;;
        pending) pe=$((pe + 1)) ;;
        failed) fl=1 ;;
        active) ac=1 ;;
      esac
    fi
    if r_is_leaf "$i"; then
      [ "${S_ST[i]}" != "active" ] || GA=$i
      if [ -n "$GEST" ] && [ "${S_ST[i]}" != "skipped" ]; then
        if [ -n "${P_EST[i]}" ]; then GEST=$((GEST + P_EST[i])); else GEST=""; fi
      fi
    fi
  done
  if [ "$GA" = "-1" ] && [ "$ac" = "1" ]; then # the build, before its first sub-step
    for ((i = 0; i < P_N; i++)); do
      if [ "${P_GROUP[i]}" = "$gid" ] && [ "${S_ST[i]}" = "active" ]; then GA=$i; break; fi
    done
  fi
  if [ "$sk" = "$n" ]; then GS=skipped
  elif [ "$fl" = "1" ]; then GS=failed
  elif [ $((sk + dn)) = "$n" ]; then GS=done
  elif [ $((sk + pe)) = "$n" ]; then GS=pending
  else GS=active; fi
}

r_draw() {
  local j i W=22 right detail name wait bw
  R_TICK=$((R_TICK + 1)); R_LAST_DRAW=$SECONDS; R_FORCE=0
  R_L=(); R_LN=0
  r_pace
  local dry=""
  [ "$DRY_RUN" != "1" ] || dry="  ·  dry run: nothing is changed"
  r_ln "${C_B}  equin installer${C_0}${C_D}  ·  $SYS_DESC  ·  $R_DIR$dry${C_0}"
  r_ln ""
  for ((j = 0; j < G_N; j++)); do
    r_group "$j"
    wait=""; [ "$GA" -lt 0 ] || wait=${S_WON[GA]}
    r_mark "$GS" "$wait"
    r_pad "${G_LABEL[j]}" "$W"; name=$PD
    case "$GS" in
      pending) name="${C_D}$name${C_0}" ;;
      active | failed) name="${C_B}$name${C_0}" ;;
    esac
    right=""; detail=""
    case "$GS" in
      done) r_fmt $((GMS / 1000)); right=$FM ;;
      skipped) detail="already installed" ;;
      pending) if [ -n "$GEST" ]; then r_approx $((GEST * PACE_A / PACE_E)); right=$AP; fi ;;
      failed) detail="${C_R}stopped${C_0}" ;;
    esac
    if [ "$GS" = "active" ]; then
      r_progress "${G_ID[j]}"
      if [ -n "$wait" ] && [ -z "${P_PARENT[GA]}" ]; then # a sub-step's wait is on its own row
        r_wait_text "$GA"; detail="${C_Y}$(r_cut "$WT" $((R_COLS - 30)))${C_0}"
      elif [ -n "$PCT" ]; then
        r_bar "$PCT" 24; r_padl "$PCT%" 4; detail="$BAR  ${C_D}$PD${C_0}"
      elif [ "$GA" -ge 0 ]; then
        detail="${C_D}${P_DOING[GA]}…${C_0}"
      fi
      r_ln "  $MK $name $detail"
    else
      r_pad "$detail" 36; detail=$PD; r_padl "$right" 8
      r_ln "  $MK $name ${C_D}$detail  $PD${C_0}"
    fi
    if [ "${G_ID[j]}" = "build" ] && { [ "$GS" = "active" ] || [ "$GS" = "failed" ]; }; then
      r_sub_rows
    fi
  done
  if [ -n "$R_DONE_URL" ]; then r_ln "  ${C_G}✓${C_0} ${C_B}Ready${C_0}"; else r_ln "  ${C_D}· Ready${C_0}"; fi
  r_ln ""
  if [ -n "$R_DONE_URL" ]; then
    r_fmt $((R_DONE_MS / 1000))
    r_ln "  ${C_G}✓${C_0} ${C_B}equin is ready${C_0}${C_D}  · installed in $FM${C_0}"
    r_ln ""
    r_ln "    open      ${C_A}$R_DONE_URL${C_0}"
    r_ln "    code      $R_DIR"
    r_ln "    data      $R_DATA"
    if [ "$OS" = "Darwin" ]; then r_ln "    starts    at every login"; else r_ln "    starts    at every boot"; fi
    r_ln ""
    if [ "$DRY_RUN" = "1" ]; then r_ln "${C_D}  Dry run: nothing on this machine was changed.${C_0}"
    elif [ "$EDIT_RC" = "1" ]; then r_ln "${C_D}  Open a new terminal to use ./equin.${C_0}"; fi
  elif [ -n "$R_EXIT" ] || [ "$R_ENDED" = "1" ]; then
    if [ "$R_EXIT" = "130" ] || [ "$R_EXIT" = "143" ] || [ "$R_EXIT" = "129" ]; then
      r_ln "  ${C_Y}Stopped.${C_0} Run the installer again to resume where it stopped."
    else
      r_tail "  │ "
    fi
    r_ln ""
    r_ln "${C_D}  log: $R_LOGPATH${C_0}"
  else
    r_progress ""
    local pct=${PCT:-0}
    bw=$((R_COLS - 60)); [ "$bw" -le 46 ] || bw=46; [ "$bw" -ge 10 ] || bw=10
    r_bar "$pct" "$bw"
    r_remaining
    r_fmt "$SECONDS"
    local tail
    if [ -n "$REM" ]; then r_left "$REM"; tail=$LF
    else r_step_n; tail="step $SN of $G_N"; fi
    r_ln "  $BAR  ${C_B}$pct%${C_0}${C_D}  ·  $FM elapsed  ·  ${C_0}${C_B}$tail${C_0}"
    r_ln ""
    local k
    for ((k = R_LOGN - 2; k < R_LOGN; k++)); do
      [ "$k" -ge 0 ] || continue
      r_ln "${C_D}  │ $(r_cut "${R_LOGS[k % 15]}" $((R_COLS - 6)))${C_0}"
    done
    r_ln ""
    r_ln "${C_D}  $(r_cut "log: $R_LOGPATH  ·  ctrl-c stops; re-running resumes" $((R_COLS - 3)))${C_0}"
  fi
  r_flush
}

r_step_n() { local j; SN=$G_N; for ((j = 0; j < G_N; j++)); do r_group "$j"; case "$GS" in done | skipped) ;; *) SN=$((j + 1)); return 0 ;; esac; done; }

r_sub_rows() {
  local i mark cnt right label waiting
  for ((i = 0; i < P_N; i++)); do
    [ "${P_PARENT[i]}" = "build" ] || continue
    waiting=${S_WON[i]}
    r_mark "${S_ST[i]}" "$waiting"; mark=$MK
    r_pad "${P_LABEL[i]}" 26; label=$PD
    [ "${S_ST[i]}" != "pending" ] || label="${C_D}$label${C_0}"
    cnt=""; right=""
    if [ "${S_ST[i]}" = "active" ] || [ "${S_ST[i]}" = "failed" ]; then
      if [ -n "${S_PD[i]}" ]; then
        if [ "${S_PU[i]}" = "%" ]; then cnt="${S_PD[i]}%"
        elif [ -n "${S_PT[i]}" ]; then cnt="${S_PD[i]}/${S_PT[i]} ${S_PU[i]}"
        else cnt="${S_PD[i]} ${S_PU[i]}"; fi
      fi
    fi
    case "${S_ST[i]}" in
      done) r_fmt $((S_MS[i] / 1000)); right=$FM ;;
      pending) if [ -n "${P_EST[i]}" ]; then r_approx $((P_EST[i] * PACE_A / PACE_E)); right=$AP; fi ;;
      skipped) right="not needed" ;;
      failed) right="stopped" ;;
      active)
        if [ -n "$waiting" ]; then right="waiting"
        elif [ -n "${P_EST[i]}" ]; then
          r_elapsed "$i"; local rem=$((P_EST[i] * PACE_A / PACE_E - E)); [ "$rem" -ge 0 ] || rem=0
          r_approx "$rem"; right="$AP left"
        fi ;;
    esac
    r_pad "$cnt" 22; cnt=$PD; r_padl "$right" 12
    if [ -n "$waiting" ]; then
      r_ln "      ${C_D}›${C_0} $label $mark ${C_Y}$cnt$PD${C_0}"
      r_wait_text "$i"
      r_ln "          ${C_Y}$(r_cut "$WT" $((R_COLS - 12)))${C_0}"
    elif [ "${S_ST[i]}" = "failed" ]; then
      r_ln "      ${C_D}›${C_0} $label $mark ${C_R}$cnt$PD${C_0}"
    else
      r_ln "      ${C_D}›${C_0} $label $mark ${C_D}$cnt$PD${C_0}"
    fi
  done
}

# r_flush: replace the block drawn last with R_L. Its height counts the rows a
# line wraps onto, so the cursor goes back up to exactly where it started.
r_flush() {
  local k out="" h=0 vis cols=$R_COLS
  [ "$cols" -gt 0 ] || cols=80
  for ((k = 0; k < R_LN; k++)); do
    vis=${R_L[k]//$'\033'\[*([0-9;])m/}
    if [ "${#vis}" -le 1 ]; then h=$((h + 1)); else h=$((h + (${#vis} - 1) / cols + 1)); fi
    out="$out${R_L[k]}"$'\n'
  done
  if [ "$R_H" -gt 0 ]; then out=$'\033['"${R_H}A"$'\r\033[J'"$out"; else out=$'\033[?25l'"$out"; fi
  printf '%s' "$out"
  R_H=$h
}

r_finish() {
  R_ENDED=1
  if [ "$MODE" = "interactive" ]; then
    if [ "$R_STARTED" = "1" ]; then R_PAUSED=0; r_draw; fi
    printf '\033[?25h'
  elif [ -z "$R_DONE_URL" ]; then
    case "$R_EXIT" in
      130 | 143 | 129) r_plain "stopped (exit $R_EXIT) · run the installer again to resume where it stopped" ;;
      *) r_plain "stopped (exit ${R_EXIT:-unknown}) · log $R_LOGPATH" ;;
    esac
  fi
}

# ── --dry-run ────────────────────────────────────────────────────────────────
# The event stream of a scripted install, touching nothing but its own run dir:
# every event type, a skipped step, output that needs escaping, git's CR
# progress (clone), counted progress (start: crates; build.interface:
# plugins), a wait with its holder, and the build's sub-steps reported the
# way `./equin build` reports them — through the FIFO opened by path
# (step_ev), which is what proves that path. EQUIN_INSTALL_DRY_RUN_PACE
# (seconds between lines, default 0) slows it down for watching a renderer;
# EQUIN_INSTALL_DRY_RUN_FAIL=<step id> fails that step's first attempt, so a
# retry decision on the control fd can be exercised.

dry_pace() {
  local pace="${EQUIN_INSTALL_DRY_RUN_PACE:-0}"
  [ "$pace" = "0" ] || sleep "$pace"
}

dry_step() {
  local i
  for i in 1 2 3; do
    echo "$1: working ($i of 3)"
    dry_pace
  done
  case "$1" in
    clone) dry_clone ;;
    start) dry_count 312 crates ;;
    build) dry_build ;;
  esac
  if [ "$1" = "toolchain" ]; then
    printf '%s\n' 'quotes "x", a backslash \ and a tab:	done' \
      $'\033[32mcolour\033[0m codes' 'unicode: é ✓ 漢字'
    # Longer than one event can carry: escapes and multibyte characters.
    printf 'long: %s\n' "$(for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do printf 'é✓ \\ "q" %s ' "$i$i$i$i$i$i$i$i"; done)"
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

# git clone --progress's output: CR-redrawn frames, each phase ending in a line.
dry_clone() {
  local p
  echo "Cloning into '$INSTALL_DIR'..." >&2
  for p in 0 12 37 64 88 100; do
    printf 'Receiving objects: %3d%% (%d/4100), %d.0 MiB | 2.0 MiB/s\r' "$p" $((p * 41)) $((p / 10)) >&2
    dry_pace
  done
  printf 'Receiving objects: 100%% (4100/4100), 10.0 MiB | 2.0 MiB/s, done.\n' >&2
  printf 'Resolving deltas:  50%% (900/1800)\rResolving deltas: 100%% (1800/1800), done.\n' >&2
}

# dry_count <total> <unit>: the step's own count, as `./equin` reports it.
dry_count() {
  local k
  for k in 0 1 2 3 4; do
    step_ev "\"type\":\"progress\",\"id\":\"${DRY_SUB:-$EQUIN_INSTALL_STEP}\",\"done\":$(($1 * k / 4)),\"total\":$1,\"unit\":\"$2\""
    dry_pace
  done
}

dry_build() {
  local sub t0 at
  for sub in build.database build.deps build.codegen build.interface build.deploy; do
    step_ev "\"type\":\"step\",\"id\":\"$sub\",\"state\":\"start\""
    t0=$SECONDS
    DRY_SUB=$sub
    echo "$sub: working"
    dry_pace
    case "$sub" in
      build.deps) dry_count 1400 packages ;;
      build.interface)
        at="$(date -u -v-2M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
        step_ev "\"type\":\"wait\",\"step\":\"$sub\",\"state\":\"start\",\"on\":\"host-grant\",\"holder\":{\"op\":\"op-dry-run\",\"kind\":\"check\",\"startedAt\":\"$at\"}"
        dry_pace; dry_pace
        step_ev "\"type\":\"wait\",\"step\":\"$sub\",\"state\":\"end\",\"on\":\"host-grant\""
        dry_count 1184 plugins ;;
    esac
    step_ev "\"type\":\"step\",\"id\":\"$sub\",\"state\":\"done\",\"ms\":$(((SECONDS - t0) * 1000))"
  done
  DRY_SUB=""
}

dry_run() {
  echo "  equin installer (dry run: nothing on this machine is changed)"
  plan_data "Download equin"
  start_hub
  ev_plan
  ev_step tools skipped
  local id
  for id in mise clone toolchain start build; do
    run_step "$id" dry_step "$id"
    [ "$STEP_RC" = "0" ] || fail "The $id step of the dry run failed." "dry run, $id"
  done
  ev_done
}

# say <message>: one of the script's own progress lines. On the terminal
# view's watch it is a log line of the view (step null): printed straight to
# the terminal it would be drawn over.
say() {
  if [ -n "$HUB_PID" ] && [ "$MODE" != "window" ] && [ -z "${EQUIN_INSTALL_STEP:-}" ]; then
    log_line "" "$*"
  else
    printf '\n\033[1m==> %s\033[0m\n' "$*"
  fi
}

# fail <message> <details>: stop the install. The message follows the
# installer message rules (plugins/infra/plugins/launcher/plugins/installer-notice/CLAUDE.md):
# what equin was doing and why, what blocked it — in the user's words, no
# internal names — and what to do now; the raw facts (paths, exit codes,
# tool output) go in <details>, printed apart and dimmed. While the terminal
# view draws, it is printed by the EXIT trap, under the view's last frame.
fail() {
  if [ -n "$HUB_PID" ] && [ "$MODE" != "window" ]; then
    FAIL_MSG=$1
    FAIL_DETAILS=${2:-}
  else
    print_fail "$1" "${2:-}"
  fi
  exit 1
}

print_fail() {
  printf '\n\033[31m%s\033[0m\n' "$1" >&2
  [ -z "$2" ] || printf '\033[2m    details: %s\033[0m\n' "$2" >&2
}

main "$@"
