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
#   --terminal       show the install in this terminal (the default: see
#                    DEFAULT_VIEW below)
#   --window         show it in its own window, or stop if the window can't
#                    open
#   --dry-run        emit the event stream of a scripted install and touch
#                    nothing (what the stream test and the window's dev loop run)
#
# Stage 0. Piped (`curl … | bash`), this file is main's, and its first job is
# to hand the install to the release it installs: it downloads that release's
# own install.sh (and, with --window, the installer window for this system)
# from the tag's GitHub Release, checks every file against the Release's
# SHA256SUMS (the window: INSTALLER-SHA256SUMS, attached after the Release),
# and runs it — in this terminal, or in the window when asked (`stage0`). A
# release cut before the hand-off existed is installed by this script's own
# steps, and so is main when the release's script can't hand main its own
# steps after the clone (the attach marker, below). Run from a checkout
# (./install.sh), it installs that checkout and skips stage 0. What a Release carries:
# plugins/installer/plugins/release-assets.
#
# Internal, passed by stage 0 and the installer window
# (plugins/installer/plugins/window), which runs this script as its child:
#   --release <tag>  this script is that release's, already verified: run the
#                    steps, never stage 0 again
#   --checkout <ref> what the new clone checks out: the release tag, or main
#   --stage0-only    stop after stage 0, printing what it decided (its test)
#   --attach <run dir> --mode <window|interactive|plain> --since <s>
#                    run only the steps after the clone, into that running
#                    install's event stream (below), <s> seconds after it began
#   --events-fd <n>  write the install's events (plugins/installer/core,
#                    protocol v1: one JSON object per line) to fd <n>
#   --control-fd <n> read decisions (retry / quit) from fd <n> when a step fails
#
# The line below says this script accepts --release / --checkout; a Release's
# release.json records it (`handoff`), and stage 0 hands over only when it is
# there. Keep it a line of its own.
# installer-handoff: 1
#
# An install of ref X runs X's own steps. This script runs the steps that
# need nothing from equin's code (the system tools, mise, the clone); once the
# checkout exists, the rest — the toolchain, start, build, done — run from the
# CHECKOUT's install.sh, attached to this run's event stream (--attach), so
# the steps and the code they install always come from the same commit, even
# when an older release's script installs main (`--ref main`, a fork). The
# line below says this script accepts --attach and speaks the install event
# protocol v1 on it; the version moves with the protocol. Keep it a line of
# its own.
# installer-attach: 1
#
# The install's internal arguments (--release, --checkout, --attach, --mode,
# --since) are read from EQUIN_INSTALL_INTERNAL_ARGS (one per line) too, so
# they stay off the command line a terminal shows in its title bar; a script
# hands them that way only to one carrying the line below (internal_args).
# installer-internal-args: env
#
# Every run keeps its events in ~/.equin/logs/install/<run>/events.jsonl
# (`latest` links to the newest run). Without a window (the default), the terminal draws
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

# The view an install shows when neither --terminal nor --window is passed —
# the ONE switch for the default: `terminal` (this terminal; the window is
# neither downloaded nor tried) or `auto` (the window wherever it can show,
# else this terminal: choose_view's guesses). The terminal by default for now
# (decided 2026-11-18); set `auto` to make the window the default again, and
# say so where the default is described (plugins/installer/CLAUDE.md
# § Running it lists them, release-assets' CLAUDE.md included).
DEFAULT_VIEW=terminal

# stage0: find the release, download it, verify it, and exec its install.sh —
# in this terminal or in the window (VIEW). Returns (instead of exec'ing) only to
# install with THIS script's steps: when the release predates the hand-off or
# could not be downloaded; it then sets CHECKOUT and says why. A file that does
# not match its sums file stops the install: nothing unverified ever runs.
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
    stage0_fallback "$want" "$tag" "it was published before releases could install themselves"
    return 0
  fi
  stage0_get "$base/download/$tag" install.sh "$dir" || { stage0_fallback "$want" "$tag" "its install script could not be downloaded"; return 0; }
  stage0_verify "$dir" install.sh
  # Installing main (or a fork's): the release's script runs only the steps
  # before the clone, then hands the rest to main's own (see the header). A
  # release from before that would install main with its own, older steps.
  if [ "$want" = main ] && ! grep -qx '# installer-attach: 1' "$dir/install.sh"; then
    stage0_fallback main "$tag" "its installer would install main with its own older steps"
    return 0
  fi

  case "$OS/$(uname -m)" in
    Darwin/*) key=macos-universal ;;
    Linux/x86_64|Linux/amd64) key=linux-x64 ;;
    Linux/aarch64|Linux/arm64) key=linux-arm64 ;;
    *) key="" ;;
  esac
  bin=""
  if [ "$VIEW" != terminal ] && [ -n "$key" ]; then
    if [ "$(json_field installers "$dir/release.json")" = 1 ]; then
      # release.json v2: the binaries are attached after the Release is
      # published, INSTALLER-SHA256SUMS last — present means every binary it
      # lists is there; absent, not attached (yet), or their build failed.
      rm -f "$dir/INSTALLER-SHA256SUMS"
      if ! stage0_get "$base/download/$tag" INSTALLER-SHA256SUMS "$dir"; then
        STAGE0_NO_WINDOW="this release's installer window isn't published (yet)"
      elif grep -qE "^[0-9a-f]{64}  \*?equin-installer-$key\$" "$dir/INSTALLER-SHA256SUMS"; then
        # release-assets' INSTALLER_BINARIES: equin-installer-<platform key>.
        bin="equin-installer-$key"
      fi
      stage0_window "$bin" INSTALLER-SHA256SUMS
    else
      # release.json v1: the binary is listed under its platform key, and in
      # SHA256SUMS.
      stage0_window "$(json_field "$key" "$dir/release.json")" SHA256SUMS
    fi
  fi

  CHECKOUT="$tag"
  [ "$want" = main ] && CHECKOUT=main
  internal_args "$dir/install.sh" --release "$tag" --checkout "$CHECKOUT"
  if choose_view "$bin" "$dir"; then
    stage0_exec "$bin" --script "$dir/install.sh" -- ${IA_ARGV[@]+"${IA_ARGV[@]}"} ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
  fi
  echo "  Installing equin ${tag#v} in this terminal${VIEW_WHY:+ ($VIEW_WHY)}."
  stage0_exec bash "$dir/install.sh" ${IA_ARGV[@]+"${IA_ARGV[@]}"} ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
}

# stage0_window <binary name or ""> <sums file>: download this platform's
# window binary into $dir, verify it against the sums file, and set bin to its
# path; bin empty (and STAGE0_NO_WINDOW saying why) when there is none or it
# could not be downloaded. Uses stage0's base, tag and dir.
stage0_window() {
  bin=""
  [ -n "$1" ] || return 0
  if stage0_get "$base/download/$tag" "$1" "$dir"; then
    stage0_verify "$dir" "$1" "$2"
    chmod +x "$dir/$1"
    bin="$dir/$1"
  else
    STAGE0_NO_WINDOW="the window could not be downloaded"
  fi
}

# stage0_exec <command…>: hand the install over (with --stage0-only, print
# the command instead).
stage0_exec() {
  if [ "$STAGE0_ONLY" = 1 ]; then
    [ -z "$IA_ENV" ] || echo "stage0: internal args: $(printf '%s' "$IA_ENV" | tr '\n' ' ')"
    echo "stage0: exec $*"
    exit 0
  fi
  [ -z "$IA_ENV" ] || export EQUIN_INSTALL_INTERNAL_ARGS="$IA_ENV"
  exec "$@"
}

# internal_args <script> <arg…>: how to hand the install's internal arguments
# to <script> — in IA_ENV (one per line, for EQUIN_INSTALL_INTERNAL_ARGS) when
# it reads them there (its `# installer-internal-args: env` line), else in
# IA_ARGV for its command line, as an older script reads them. A terminal
# shows the running command line in its title bar: the install's plumbing
# stays out of it.
internal_args() {
  local script=$1
  shift
  IA_ENV="" IA_ARGV=()
  if grep -qx '# installer-internal-args: env' "$script" 2>/dev/null; then
    IA_ENV="$(printf '%s\n' "$@")"
  else
    IA_ARGV=("$@")
  fi
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
    echo "  Installing equin ${CHECKOUT#v} in this terminal, with the steps of the installer you downloaded: that release's own installer can't be used, because $3."
  fi
}

# stage0_get <url base> <file> <dir>: download one file of the release.
stage0_get() {
  curl -fsSL --retry 2 -o "$3/$2.part" "$1/$2" 2>/dev/null && mv "$3/$2.part" "$3/$2"
}

# stage0_verify <dir> <file> [sums file]: the file's sha256 is the one the
# sums file (in <dir>; default SHA256SUMS) lists for it, or the install stops —
# a damaged or changed download is never run.
stage0_verify() {
  # shasum first: macOS's /sbin/sha256sum is BSD's, which reads no list on
  # stdin; Linux without perl's shasum has GNU's sha256sum.
  local line sums="${3:-SHA256SUMS}" sum="shasum -a 256"
  command -v shasum >/dev/null 2>&1 || sum=sha256sum
  line="$(grep -E "^[0-9a-f]{64}  \*?$2\$" "$1/$sums" || true)"
  if [ -z "$line" ] || ! (cd "$1" && printf '%s\n' "$line" | $sum -c --status >/dev/null 2>&1); then
    rm -f "$1/$2"
    fail "The download was damaged or changed, so the installer stopped. Nothing was installed. Run the installer again; if it stops here again, tell us: https://github.com/equinai/equin/issues" \
      "$2 does not match the release's $sums (${line:-no entry for it}), in $1"
  fi
}

# other_instance: prints the checkout this account's equin already runs from,
# and succeeds, when that is not the folder this run installs into. The same
# two records `instance-owner` reads: the checkout main's deploy names, and the
# one the background service is registered to follow. A record naming a folder
# that is gone (the code moved) claims nothing; one naming a main slot claims
# its repository.
other_instance() {
  local target spec claim unit common
  target="$INSTALL_DIR"
  [ -d "$target" ] && target="$(cd "$target" && pwd -P)"
  spec="$(data_root)/worktrees/singularity/spec.json"
  for claim in \
    "$( [ -f "$spec" ] && json_field server "$spec" | sed 's|/plugins/framework/plugins/server-core$||' )" \
    "$(for unit in "$HOME/Library/LaunchAgents/dev.equin.gateway.plist" "$HOME/Library/LaunchAgents/dev.singularity.gateway.plist"; do
         [ -f "$unit" ] && awk 'f { sub(/.*<string>/, ""); sub(/<\/string>.*/, ""); print; exit } /<string>-main-checkout<\/string>/ { f = 1 }' "$unit"
       done | head -n 1)" \
    "$(for unit in "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dev.equin.gateway.service" "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dev.singularity.gateway.service"; do
         [ -f "$unit" ] && sed -n 's/^ExecStart=.*"-main-checkout" "\([^"]*\)".*/\1/p' "$unit"
       done | head -n 1)"; do
    [ -n "$claim" ] && [ -d "$claim" ] || continue
    # A claim naming one of main's slots (infra/git/main-slots: a linked
    # worktree of the repo) claims its repository: the repo's main checkout.
    common="$(git -C "$claim" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
      && [ -d "$common" ] && claim="$(dirname "$common")"
    claim="$(cd "$claim" && pwd -P)"
    if [ "$claim" != "$target" ]; then
      printf '%s\n' "$claim"
      return 0
    fi
  done
  return 1
}

# json_field <key> <file>: the value of `"key": value` in a release.json
# (written one key per line by release-assets' assemble), quotes dropped;
# empty when the key is absent.
json_field() {
  sed -n "s/^[[:space:]]*\"$1\":[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*\$/\1/p" "$2" | head -n 1
}

# choose_view <window binary or ""> <dir>: 0 = the window, 1 = this terminal,
# with the reason in VIEW_WHY (empty for the default view, which needs none).
# VIEW is what was asked, else DEFAULT_VIEW. `auto`: the window only where it can really show: a
# desktop session, not over SSH or in CI, output on a terminal, not inside a
# sandboxed shell, and the binary's own --probe (a hidden window loading the
# page: on Linux it also catches a missing webkit2gtk, which the loader
# refuses before the program starts). --window skips the guesses but not the
# probe, and stops loudly when the window can't open; --terminal never tries.
choose_view() {
  VIEW_WHY=""
  if [ "$VIEW" = terminal ]; then
    [ "$VIEW_ASKED" != terminal ] || VIEW_WHY="you asked for it with --terminal"
    return 1
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
    elif [ -n "${CLAUDECODE:-}${APP_SANDBOX_CONTAINER_ID:-}$(sandboxed)" ]; then
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
  # The internal arguments the script that started this one handed over off
  # the command line (internal_args): read first, never passed on.
  if [ -n "${EQUIN_INSTALL_INTERNAL_ARGS:-}" ]; then
    local internal=() a
    while IFS= read -r a; do internal+=("$a"); done <<<"$EQUIN_INSTALL_INTERNAL_ARGS"
    unset EQUIN_INSTALL_INTERNAL_ARGS
    set -- "${internal[@]}" "$@"
  fi

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
  ATTACH=""
  ATTACH_MODE=""
  AFTER=""
  YES=0
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
      --attach) ATTACH="$2"; shift 2 ;;
      --mode) ATTACH_MODE="$2"; shift 2 ;;
      --since) SECONDS="$2"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --fix) AFTER=fix; shift ;;
      --report) AFTER=report; shift ;;
      --yes) YES=1; shift ;;
      --events-fd) EV_FD="$2"; shift 2 ;;
      --control-fd) CTL_FD="$2"; shift 2 ;;
      -h|--help) echo "usage: install.sh [--dir <path>] [--repo <url>] [--no-shell-rc] [--ref <tag|main>] [--terminal | --window] [--dry-run]"
        if [ "$DEFAULT_VIEW" = terminal ]; then
          echo "       the install shows in this terminal; --window shows it in its own window instead"
        else
          echo "       the install shows in its own window where one can open, else in this terminal; --terminal keeps it here"
        fi
        echo "       install.sh --fix [--yes]   start Claude Code on the problem the last install stopped on"
        echo "       install.sh --report        print (and open) the GitHub issue link for it"; exit 0 ;;
      *) echo "install.sh: unknown option '$1' (see --help)" >&2; exit 2 ;;
    esac
  done

  # What was asked (for the messages), then the view this run uses.
  VIEW_ASKED="$VIEW"
  VIEW="${VIEW:-$DEFAULT_VIEW}"

  OS="$(uname -s)"
  [ -z "$AFTER" ] || after_pause "$AFTER"
  open_streams

  if [ "$DRY_RUN" = "1" ] && [ -z "$ATTACH" ]; then
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

  # The file a NEW terminal of the user's shell reads (the doctor's
  # doctor.sh picks the same one). bash on macOS: Terminal opens a login
  # shell, which reads the first of ~/.bash_profile, ~/.bash_login,
  # ~/.profile — never ~/.bashrc. On Linux a terminal is a non-login shell,
  # which reads ~/.bashrc.
  case "${SHELL:-}" in
    */bash)
      SH_NAME=bash
      RC="$HOME/.bashrc"
      if [ "$OS" = "Darwin" ]; then
        RC="$HOME/.bash_profile"
        for f in .bash_profile .bash_login .profile; do
          if [ -f "$HOME/$f" ]; then RC="$HOME/$f"; break; fi
        done
      fi
      ;;
    *) RC="$HOME/.zshrc"; SH_NAME=zsh ;;
  esac

  # Attached: the checkout's steps, into the install that cloned it.
  if [ -n "$ATTACH" ]; then
    attach_streams
    cd "$INSTALL_DIR"
    if [ "$CHECKOUT" = main ]; then WHAT="main's newest version of equin"; else WHAT="equin ${CHECKOUT#v}"; fi
    plan_data "Download equin"
    if [ "$DRY_RUN" = "1" ]; then dry_checkout_steps; else checkout_steps; fi
    exit 0
  fi

  # ── 0. Say what will happen, before anything does ──────────────────────────
  if [ "$(id -u)" = "0" ]; then
    fail "equin can't be installed from the administrator (root) account: its database refuses to run as root, so equin could never start. Run the installer from your normal account. On a server with only root, create one first: adduser --disabled-password --gecos '' equin && su - equin" \
      "id -u = 0; initdb refuses to run as root"
  fi

  # ── One equin per account ─────────────────────────────────────────────────
  # Before anything is downloaded: a second checkout would share this account's
  # database, address and background service, and its build would replace the
  # equin running from the first. `./equin start` and a main `./equin build`
  # refuse the same way (infra/launcher/instance-owner); this is the early,
  # cheap read of the same two records.
  if held="$(other_instance)"; then
    fail "equin is already installed on this account, from another folder (named below). A second one would share its database, its address and its background service, so installing it would replace the equin you use, possibly with an older version than your data. Nothing was changed. To update the equin you have, run ./install.sh from that folder. To try a second equin, use another account on this computer, or a virtual machine. If that folder is a leftover copy you no longer use, run ./equin stop --disable there, move it away, then run this again." \
      "this account's equin runs from $held; this install: $INSTALL_DIR"
  fi

  # ── Stage 0: piped from main → the release's own script takes over ─────────
  if [ -z "$SELF_DIR" ] && [ -z "$RELEASE" ] && [ -z "$EV_FD" ]; then
    stage0
    if [ "$STAGE0_ONLY" = 1 ]; then
      echo "stage0: own steps, checkout $CHECKOUT"
      exit 0
    fi
  elif [ -n "$SELF_DIR" ] && [ -n "$REF$VIEW_ASKED" ]; then
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

  # Step 1 is this system's own: each OS reads only what it will do.
  local prep1 prep2
  if [ "$OS" = "Darwin" ]; then
    prep1="install Apple's command-line developer tools, if missing"
    if [ "$MODE" = "window" ]; then prep2="(Apple's own window asks you to confirm)"; else prep2="(asks for your password once)"; fi
  else
    prep1="install git and a C compiler with apt, and let equin keep running"
    prep2="while nobody is logged in; asks for your password once"
  fi
  cat <<EOF

  equin installer. This will:
    1. $prep1
       $prep2
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

  # ── Not from inside another app's protected mode ──────────────────────────
  # Checked before any step, so it never fails six minutes in: a coding tool's
  # protected shell (Claude Code's: its writes outside the project refused;
  # sandbox-exec, which other tools run commands under) stops the install
  # part-way, compilers first.
  sandbox_check

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

  # ── The checkout's own steps from here (see the header) ───────────────────
  # Run from the checkout itself, this script already is its own.
  [ -n "$SELF_DIR" ] || hand_to_checkout "$INSTALL_DIR/install.sh"
  checkout_steps
}

# checkout_steps: the steps that need equin's code — run by the checkout's
# own install.sh, in its folder, with mise's tools on PATH.
checkout_steps() {
  MISE="$HOME/.local/bin/mise"
  command -v mise >/dev/null 2>&1 && MISE="$(command -v mise)"

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
  run_step start start_services
  if [ "$STEP_RC" != "0" ]; then
    fail "equin could not start; what stopped it is just above. Once that is sorted, run the installer again: it picks up where it stopped (cd $INSTALL_DIR && ./install.sh)." \
      "./equin start exited non-zero"
  fi
  # The port is chosen by the start just above; never spelled here.
  APP_URL="$(./equin url)"
  [ -n "$APP_URL" ] || fail "equin started but could not say where it answers. Run the installer again (cd $INSTALL_DIR && ./install.sh)." \
    "./equin url printed nothing"

  STATUS="$(data_root)/worktrees/singularity/build-status.json"
  say "Building equin (the long step: about 10 minutes)"
  # ONE build of this tree, not two. `./equin start` brought equin's
  # background service up, and its first boot already deploys main the way
  # every later update is deployed: a convergence run (`./equin build
  # --allow-main --converge`; a first deploy runs without the full check pass,
  # build/converge cli/internal/plan.ts). This step is that same run: it waits
  # for the service's (its deploy lock — a wait naming the build that holds
  # it) and finds main deployed, or deploys it itself when the service's run
  # has not started yet. Only when that left this version undeployed (its
  # build failed: a convergence run decides a commit once) does the step build
  # it here, so the failure is this step's own output.
  run_step build deploy_main "$STATUS"
  [ "$STEP_RC" = "0" ] || fail "equin did not finish building, so it cannot open yet; what went wrong is in the output above. Run the installer again to retry (cd $INSTALL_DIR && ./install.sh)." \
    "./equin build exited non-zero"
  # The receipt is the authority on whether it deployed, not the exit code.
  if ! deployed_at_head "$STATUS"; then
    fail "equin did not finish building, so it cannot open yet; what went wrong is in the output above. Run the installer again to retry (cd $INSTALL_DIR && ./install.sh)." \
      "no ok deploy receipt for $(git rev-parse HEAD) in $STATUS"
  fi

  # ── 7. Done ────────────────────────────────────────────────────────────────
  ev_done
  done_wait
  # Without a window (the default) the terminal view draws the same in its done state.
  if [ "$MODE" = "window" ]; then
    say "equin is running: $APP_URL"
    echo "  equin's code is in $INSTALL_DIR"
    if [ "$EDIT_RC" = "1" ]; then
      echo "  To use ./equin: open a new terminal, then cd $INSTALL_DIR (its tools are found inside that folder)."
    fi
  fi
}

# ── Step bodies ──────────────────────────────────────────────────────────────
# Each runs inside run_step's subshell, under `set -e`: it may print anything
# (that is the step's log) and fails by exiting non-zero. State the rest of the
# install needs (PATH, the current directory) is set by main(), never here.

# deployed_at_head <receipt>: main's deploy receipt says ok, for this
# checkout's HEAD — whoever built it (the service's first-boot run, or this
# install).
deployed_at_head() {
  grep -q '"status": *"ok"' "$1" 2>/dev/null &&
    grep -q "\"commit\": *\"$(git rev-parse HEAD)\"" "$1"
}

# deploy_main <receipt>: the build step's body (see the step).
deploy_main() {
  local before
  before="$(grep -o '"buildId": *"[^"]*"' "$1" 2>/dev/null || true)"
  # Its own failure (the gateway follow after the builds, say) is not the
  # install's verdict: the receipt is.
  ./equin build --allow-main --converge || echo "The deploy run exited non-zero; checking whether equin deployed anyway."
  deployed_at_head "$1" && return 0
  # A build of this version ran during this step and did not deploy (here,
  # or in the background service's run): building the same tree again would
  # fail the same way, twice as slowly. Its log says why; running the
  # installer again builds it here, in this step's output.
  if [ "$(grep -o '"buildId": *"[^"]*"' "$1" 2>/dev/null || true)" != "$before" ]; then
    echo "The build of this version did not deploy. Its log: $(grep -o '"logPath": *"[^"]*"' "$1" | sed 's/.*: *"//; s/"$//')"
    return 1
  fi
  echo "This version of equin is not deployed yet; building it here."
  # --skip-checks: this deploys main, whose tree already passed the full check
  # pass when it was pushed. With nothing served yet the build runs no
  # validation at all (firstMainDeploy, build's cli/run.ts) — the same as the
  # service's first build.
  ./equin build --allow-main --skip-checks
}

install_xcode_tools() {
  # In the window: Apple's own dialog, which asks for whatever it needs
  # itself — the window never asks for an administrator password.
  if [ "$MODE" = "window" ]; then
    xcode_dialog
    return 0
  fi
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
    xcode_dialog
  fi
}

# xcode_dialog: Apple's "Install Command Line Developer Tools" dialog, waited
# out: until the tools are there, or the dialog is gone without them (the step
# then fails, and Try again opens it again). Checked every 5 s — an OS dialog
# has no change signal to wait on (a documented exception to "no polling").
xcode_dialog() {
  local seen=0 n=0
  echo "Installing Apple's developer tools: click Install in Apple's window. It can take 5 to 20 minutes."
  xcode-select --install 2>&1 || true
  step_ev "\"type\":\"wait\",\"step\":\"tools\",\"state\":\"start\",\"on\":\"apple-installer\""
  until xcode-select -p >/dev/null 2>&1; do
    sleep 5
    n=$((n + 1))
    if pgrep -f "Install Command Line Developer Tools" >/dev/null 2>&1; then
      # Apple's dialog opens behind the install window (which takes focus as
      # it opens), where the user never sees what they are told to click:
      # bring it to the front once. `open -a` on a running app only
      # activates it — no permission asked.
      [ "$seen" = 1 ] || open -a "/System/Library/CoreServices/Install Command Line Developer Tools.app" 2>&1 || true
      seen=1
    elif [ "$seen" = 1 ] || [ "$n" -ge 12 ]; then break; fi # gone, or never came in a minute
  done
  step_ev "\"type\":\"wait\",\"step\":\"tools\",\"state\":\"end\",\"on\":\"apple-installer\""
  xcode-select -p >/dev/null 2>&1 || { echo "Apple's installer closed without installing the developer tools."; exit 1; }
}

# sudo_once [why]: ask for the password now, as a wait the terminal view stops
# redrawing for (the prompt is on the terminal, below its status block); the
# step's later sudo calls reuse it. In the window on Linux the window asks
# (sudo's askpass: the window's own binary, `--askpass`, which asks the window
# over its socket to show a password sheet) — the password goes to sudo only.
sudo_once() {
  local rc=0
  if sudo -n true 2>/dev/null; then return 0; fi
  step_ev "\"type\":\"wait\",\"step\":\"$EQUIN_INSTALL_STEP\",\"state\":\"start\",\"on\":\"password\""
  if [ "$MODE" = "window" ] && [ -n "${EQUIN_INSTALLER_BIN:-}" ] && [ -n "${EQUIN_INSTALLER_ASKPASS:-}" ]; then
    printf '#!/bin/sh\nexec %s --askpass "$@"\n' "$(q "$EQUIN_INSTALLER_BIN")" >"$RUN_DIR/askpass"
    chmod +x "$RUN_DIR/askpass"
    SUDO_ASKPASS="$RUN_DIR/askpass" sudo -A -p "${1:-equin needs your password to install git and a C compiler, and to keep running while nobody is logged in.} It is used for this only and never stored." -v || rc=$?
  else
    sudo -v || rc=$?
  fi
  step_ev "\"type\":\"wait\",\"step\":\"$EQUIN_INSTALL_STEP\",\"state\":\"end\",\"on\":\"password\""
  return "$rc"
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

# start_services: the start step's body. First what the OS must provide for
# the parts `./equin start` adds here — declared by those parts themselves
# (Dep.systemPackages; the menu-bar icon's GTK and WebKitGTK on a desktop),
# asked of `./equin start --system-packages`, never listed here — then start.
# A failed package install does not stop the step: start then fails on that
# optional part with its own diagnosis (what it gives, the packages it lacks,
# Skip).
start_services() {
  local out pkgs="" p
  if [ "$OS" != "Darwin" ] && command -v apt-get >/dev/null 2>&1; then
    out="$(./equin start --system-packages)"
    # Its one marked line; any other output (a dependency install's) is not
    # a package name.
    pkgs="$(printf '%s\n' "$out" | sed -n 's/^system-packages://p' | tail -n 1)"
    printf '%s\n' "$out" | grep -q '^system-packages:' || {
      echo "./equin start --system-packages answered no system-packages: line:"; printf '%s\n' "$out"; return 1; }
    for p in $pkgs; do
      case "$p" in
        *[!a-z0-9.+:-]*|[!a-z0-9]*) echo "./equin start --system-packages named \"$p\", which is not a package name"; return 1 ;;
      esac
    done
  fi
  if [ -n "$pkgs" ]; then
    say "Installing the libraries equin's desktop icon is built with (asks for your password)"
    echo "apt packages: $pkgs"
    # A lock held by the system's own updates on a fresh machine is waited
    # out; an update error from another source does not stop the install.
    # shellcheck disable=SC2086 # one word per package
    if sudo_once "equin needs your password to install the libraries its desktop icon is built with." &&
      { sudo apt-get -o DPkg::Lock::Timeout=300 update -qq || echo "apt-get update reported errors; installing anyway."; } &&
      sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq $pkgs; then :
    else
      echo "Those packages did not install; equin starts anyway and says what is missing."
    fi
  fi
  ./equin start
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

# Where equin answers once it runs: main's address on this account's gateway
# port, read from `./equin url` after the start step chose and recorded it
# (the first free port of the range). Empty until then.
APP_URL=""
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
CF_FD=""
LOG_FD=""
FWD_PID=""
KEYS_PID=""
RUN_DIR=""
FIFO=""
CFIFO=""
PAUSE_QUIT=0
# The optional parts the person skipped (comma-separated ids), handed to every
# later step attempt as EQUIN_INSTALL_LEFT_OUT (run_step).
LEFT_OUT=""
DONE_SENT=0
FAIL_MSG=""
FAIL_DETAILS=""
EST_SET=""
IA_ENV=""
IA_ARGV=()

# BEGIN estimates — generated by `./equin installer estimates` from plugins/installer/core/estimates.json; do not edit
# est_s <set> <step id>: the step's median in seconds, or null.
est_s() {
  case "$1:$2" in
    macos-window:tools) echo 211 ;;
    macos-window:mise) echo 1 ;;
    macos-window:clone) echo 16 ;;
    macos-window:toolchain) echo 17 ;;
    macos-window:start) echo 122 ;;
    macos-window:build) echo 114 ;;
    macos-window:build.database) echo 1 ;;
    macos-window:build.deps) echo 1 ;;
    macos-window:build.codegen) echo 23 ;;
    macos-window:build.interface) echo 69 ;;
    macos-window:build.deploy) echo 11 ;;
    macos-terminal:tools) echo 80 ;;
    macos-terminal:mise) echo 2 ;;
    macos-terminal:clone) echo 15 ;;
    macos-terminal:toolchain) echo 21 ;;
    macos-terminal:start) echo 122 ;;
    macos-terminal:build) echo 114 ;;
    macos-terminal:build.database) echo 1 ;;
    macos-terminal:build.deps) echo 1 ;;
    macos-terminal:build.codegen) echo 23 ;;
    macos-terminal:build.interface) echo 69 ;;
    macos-terminal:build.deploy) echo 11 ;;
    linux:tools) echo 18 ;;
    linux:mise) echo 1 ;;
    linux:clone) echo 14 ;;
    linux:toolchain) echo 9 ;;
    linux:start) echo 109 ;;
    linux:build) echo 114 ;;
    linux:build.database) echo 1 ;;
    linux:build.deps) echo 1 ;;
    linux:build.codegen) echo 23 ;;
    linux:build.interface) echo 69 ;;
    linux:build.deploy) echo 11 ;;
    *) echo "install.sh: no estimate entry for step '$2' in set '$1'" >&2; exit 2 ;;
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
  # The event stream's reader gone (the hub, the window): a write to it kills
  # this script with SIGPIPE, which no EXIT trap sees — exit through on_exit
  # instead, which says so.
  trap 'exit 141' PIPE
  return 0
}

# The EXIT trap: the exit event, then the hub drained (the terminal view draws
# its last frame), timing.json after a success, and only then a failure's
# message — below the terminal view's last frame, never under its redraws.
on_exit() {
  local rc=$? cause=""
  set +e
  # Its own writes to a reader that is gone fail (EPIPE) rather than kill it,
  # and a stop arriving now (view_ended's TERM) cannot cut this trap short.
  trap '' PIPE TERM INT HUP
  if [ -n "$RUN_DIR" ] && [ -f "$RUN_DIR/view-ended" ]; then
    cause=$(cat "$RUN_DIR/view-ended")
    [ -n "$FAIL_MSG" ] || FAIL_MSG="The installer stopped: $cause. Run the installer again: it picks up where it stopped."
    [ -n "$FAIL_DETAILS" ] || FAIL_DETAILS="log: $RUN_DIR/install.log"
  elif [ "$rc" = 141 ]; then
    cause="the install's event stream lost its reader (SIGPIPE)"
    [ -n "$FAIL_MSG" ] || FAIL_MSG="The installer stopped: $cause. Run the installer again: it picks up where it stopped."
    [ -z "$RUN_DIR" ] || FAIL_DETAILS="log: $RUN_DIR/install.log"
  fi
  if [ -n "$cause" ]; then
    json_str "$cause"
    cause=",\"cause\":$JSON_STR"
  fi
  if [ -n "$HUB_PID" ]; then
    # Attached steps that sent done, even if a signal cut the wait after it.
    if [ -n "$RUN_DIR" ] && [ -f "$RUN_DIR/attached-done" ]; then
      rm -f "$RUN_DIR/attached-done"
      DONE_SENT=1
    fi
    # The hub gone (SIGPIPE): the exit event straight into the record.
    if ! ev exit "\"code\":$rc$cause" 2>/dev/null; then
      ev_now
      printf '{"v":1,"t":"%s","type":"exit","code":%s%s}\n' "$EV_T" "$rc" "$cause" >>"$RUN_DIR/events.jsonl"
    fi
    eval "exec $HUB_FD>&-"
    EV_OUT=""
    wait "$HUB_PID"
    rm -f "$FIFO" "$CFIFO" "$RUN_DIR/pid"
    stop_keys
    [ -z "$FWD_PID" ] || kill "$FWD_PID" 2>/dev/null
    if [ "$DONE_SENT" = "1" ]; then
      write_timing
      rm -f "$RUN_DIR/diagnosis.json"
    fi
  elif [ -n "$ATTACH" ]; then
    # The install that started this one writes `exit` and prints the message,
    # below its terminal view's last frame.
    [ -z "$FAIL_MSG" ] || printf '%s\n%s\n' "$FAIL_MSG" "$FAIL_DETAILS" >"$RUN_DIR/attached-fail"
    FAIL_MSG=""
    rm -f "$RUN_DIR/attached-pid"
  else
    ev exit "\"code\":$rc$cause"
  fi
  if [ -n "$FAIL_MSG" ]; then
    print_fail "$FAIL_MSG" "$FAIL_DETAILS"
  fi
  exit "$rc"
}

# free_fds: HUB_FD (this script's write end of the event FIFO), CF_FD (the
# control FIFO, held read-write) and LOG_FD (install.log): the first fds from 9
# down the window did not hand over.
free_fds() {
  local fd picked=""
  for fd in 9 8 7 6 5; do
    if [ "$fd" != "$EV_FD" ] && [ "$fd" != "$CTL_FD" ]; then
      picked="$picked $fd"
    fi
  done
  set -- $picked
  HUB_FD=$1 CF_FD=$2 LOG_FD=$3
}

# start_hub: this run's dir and FIFO, the hub reading it, and this script's
# write end (HUB_FD). Needs plan_data first (the terminal view draws its rows).
#
# Beside the events, the run dir holds what a pause needs: install.log (every
# log line, whole — events.jsonl cuts the long ones), control.fifo (where every
# decision arrives: the window's, a key in the terminal, Claude's `resume`) and
# pid. Decisions come from several writers, and a bash `read` waits on one fd,
# so each source is a forwarder into the one FIFO; this script holds it open
# read-write for its whole life, so a writer opening it by path never blocks.
start_hub() {
  local root run_id
  root="$(data_root)/logs/install"
  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  RUN_DIR="$root/$run_id"
  FIFO="$RUN_DIR/events.fifo"
  CFIFO="$RUN_DIR/control.fifo"
  mkdir -p "$RUN_DIR"
  mkfifo -m 600 "$FIFO"
  mkfifo -m 600 "$CFIFO"
  printf '%s\n' "$$" >"$RUN_DIR/pid"
  ln -sfn "$run_id" "$root/latest"
  free_fds
  # The hub ignores the signals that stop the install: it drains what the
  # writers wrote and ends at EOF, after the exit event.
  if [ "$MODE" = "window" ]; then
    (
      trap '' INT TERM HUP
      [ -z "$CTL_FD" ] || eval "exec $CTL_FD<&-"
      exec tee -a "$RUN_DIR/events.jsonl" <"$FIFO" >&"$EV_FD"
    ) &
  else
    # The view in a subshell of its own, so whatever ends it (even a bash
    # error) leaves view_ended to see its status and keep tee's reader alive
    # (and no `set -e` there: a failing view must not end the group first).
    ( trap '' INT TERM HUP; tee -a "$RUN_DIR/events.jsonl" <"$FIFO" | { set +e; (render); view_ended $?; } ) &
  fi
  HUB_PID=$!
  eval "exec $CF_FD<>\"\$CFIFO\""
  eval "exec $LOG_FD>>\"\$RUN_DIR/install.log\""
  # The window's decisions (fd 4) into the control FIFO; the window closing
  # (EOF) is `eof`, read as quit. Fix with Claude (and Show Claude) it carries
  # out itself, from the files the pause left in the run dir: a stall pause
  # offers it while the step still runs and this script cannot read a
  # decision. It holds no end of the event stream (its events are written by
  # path), so a killed install still ends the window's stream.
  if [ -n "$CTL_FD" ]; then
    (
      trap '' INT TERM HUP
      eval "exec $EV_FD>&-"
      EV_OUT="" EV_BY_PATH=1
      while IFS= read -r line <&"$CTL_FD"; do
        case "$line" in
          fix-app) fix_app ;;
          fix-cli) fix_cli ;;
          show-claude) show_claude ;;
          *) printf '%s\n' "$line" >&"$CF_FD" ;;
        esac
      done
      printf 'eof\n' >&"$CF_FD"
    ) &
    FWD_PID=$!
  fi
  # Blocks until the hub has the read end open.
  eval "exec $HUB_FD>\"\$FIFO\""
  EV_OUT=$HUB_FD
  CLOSE_FDS="$CLOSE_FDS $HUB_FD>&- $CF_FD<&- $LOG_FD>&-"
  write_resume
}

# attach_streams: --attach's side of start_hub — the running install's run
# dir, its FIFO (the hub that owner started reads it; this script writes its
# own events on a write end of its own), its control FIFO and install.log.
# The owner keeps the hub, the window's fds, the forwarder and pid: it waits
# for this script and ends the stream (`exit`) when it does.
attach_streams() {
  RUN_DIR=$ATTACH
  FIFO="$RUN_DIR/events.fifo"
  CFIFO="$RUN_DIR/control.fifo"
  if ! [ -p "$FIFO" ] || ! [ -p "$CFIFO" ]; then
    echo "install.sh: --attach: no install is running in '$RUN_DIR'" >&2; exit 2
  fi
  case "$ATTACH_MODE" in
    window|interactive|plain) MODE=$ATTACH_MODE ;;
    *) echo "install.sh: --attach needs --mode window, interactive or plain (got '$ATTACH_MODE')" >&2; exit 2 ;;
  esac
  free_fds
  eval "exec $CF_FD<>\"\$CFIFO\""
  eval "exec $LOG_FD>>\"\$RUN_DIR/install.log\""
  # The hub has the read end open: this never blocks.
  eval "exec $HUB_FD>\"\$FIFO\""
  EV_OUT=$HUB_FD
  CLOSE_FDS="$HUB_FD>&- $CF_FD<&- $LOG_FD>&-"
  # So the hub can stop this script too when the terminal view ends early.
  printf '%s\n' "$$" >"$RUN_DIR/attached-pid"
  # Run again from now on, the install resumes from this checkout.
  write_resume
}

# hand_to_checkout <the checkout's install.sh> [args…]: run the rest of the
# install with the checkout's own steps (see the header), attached to this
# run's stream, and exit with its status. Never returns, except for a
# checkout from before --attach existed (no marker): its steps can't attach,
# so this script's run them, as every install did then.
hand_to_checkout() {
  local script=$1 marker rc
  shift
  rm -f "$RUN_DIR/attached-done" "$RUN_DIR/attached-fail" "$RUN_DIR/attached-pid"
  marker="$(grep -m 1 '^# installer-attach: ' "$script" 2>/dev/null || true)"
  if [ -z "$marker" ]; then
    say "This version of equin is older than this installer, so the installer's own steps install it."
    return 0
  fi
  [ "$marker" = "# installer-attach: 1" ] || fail "This version of equin installs itself with newer steps than this installer can show, so the installer stopped. What it did so far is kept: finish the install from equin's folder with: cd $INSTALL_DIR && ./install.sh" \
    "$script says '$marker'; this installer speaks '# installer-attach: 1'"
  internal_args "$script" --attach "$RUN_DIR" --mode "$MODE" --since "$SECONDS" \
    --checkout "$CHECKOUT" ${RELEASE:+--release "$RELEASE"}
  set +e
  (
    eval "exec $CLOSE_FDS"
    [ -z "$IA_ENV" ] || export EQUIN_INSTALL_INTERNAL_ARGS="$IA_ENV"
    exec bash "$script" ${IA_ARGV[@]+"${IA_ARGV[@]}"} "$@" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
  )
  rc=$?
  set -e
  if [ -f "$RUN_DIR/attached-fail" ]; then
    { IFS= read -r FAIL_MSG; IFS= read -r FAIL_DETAILS; } <"$RUN_DIR/attached-fail" || true
    rm -f "$RUN_DIR/attached-fail"
  fi
  if [ -f "$RUN_DIR/attached-done" ]; then
    rm -f "$RUN_DIR/attached-done"
    DONE_SENT=1
  elif [ "$rc" = 0 ]; then
    # Its status says done but it never said so: a crash, never a success.
    rc=1
    FAIL_MSG="The install stopped before it finished, without saying why. Run the installer again: it picks up where it stopped (cd $INSTALL_DIR && ./install.sh)."
    FAIL_DETAILS="$script --attach exited 0 without the done event"
    [ "$MODE" != "window" ] || { print_fail "$FAIL_MSG" "$FAIL_DETAILS"; FAIL_MSG=""; }
  fi
  exit "$rc"
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
  if [ -n "${EV_BY_PATH:-}" ]; then # a helper process: the FIFO by path, one write
    ev_now
    printf '{"v":1,"t":"%s","type":"%s"%s}\n' "$EV_T" "$1" "${2:+,$2}" >"$FIFO"
    return 0
  fi
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
  # Attached: tells the install that started this one that it finished.
  [ -z "$ATTACH" ] || : >"$RUN_DIR/attached-done"
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
  [ -z "$LOG_FD" ] || printf '%s\n' "$text" >&"$LOG_FD"
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

# read_tick <seconds>: one line of stdin, or <seconds> without one — told
# apart the same way under every bash, as `read -t` itself does not: bash 3.2
# answers a timeout with status 1 and the variable left as it was, bash >= 4
# with a status above 128 and the variable set to what came so far (often
# empty, which reads as EOF to a loop that trusts the variable). Returns 0 (a
# line, in RL_LINE), 1 (EOF; RL_LINE holds an unterminated last line, maybe
# empty) or 2 (the timeout). A line cut by a timeout is carried in RL_PART
# (bash >= 4 hands it over; 3.2 drops it): a loop clears RL_PART before it
# starts.
read_tick() {
  local line=$'\001' rc=0
  IFS= read -r -t "$1" line || rc=$?
  if [ "$rc" = 0 ]; then
    RL_LINE=$RL_PART$line; RL_PART=""; return 0
  fi
  if [ "$rc" -gt 128 ]; then RL_PART=$RL_PART$line; return 2; fi
  [ "$line" != $'\001' ] || return 2
  RL_LINE=$RL_PART$line; RL_PART=""; return 1
}

# ev_lines <step id>: each line of stdin, as a log event of that step — with
# the no-progress watchdog. A step that prints nothing and reports nothing
# (no event reached events.jsonl) for STALL_S seconds (10 min, or 3 × its
# median when that is longer; EQUIN_INSTALL_STALL_S overrides it to reproduce
# one) gets a stall pause that does not stop it: the person sees it is stuck
# and can Fix with Claude, and the pause ends (`resolved progress`) with the
# next line. A deadline on work this script cannot otherwise observe, re-armed
# on every line — not polling. An open wait (a password, Apple's installer,
# the machine's build slot, which has its own rule) is not a stall.
ev_lines() {
  local quiet stalled=0 age est
  est="$(est_s "$EST_SET" "$1")"
  quiet=600
  [ "$est" = "null" ] || [ $((est * 3)) -le "$quiet" ] || quiet=$((est * 3))
  quiet=${EQUIN_INSTALL_STALL_S:-$quiet}
  RL_PART=""
  while :; do
    if read_tick "$quiet"; then
      [ "$stalled" = 0 ] || { ev resolved '"how":"progress"'; stalled=0; }
      log_line "$1" "$RL_LINE"
    elif [ $? = 1 ]; then
      [ -z "$RL_LINE" ] || log_line "$1" "$RL_LINE"
      break
    else
      # Quiet here, but the step's own `./equin` may have reported (its
      # events skip this reader): stalled only when events.jsonl is as old.
      # GNU stat first: its `-f` is the file system's status, not BSD's format.
      age=$(($(date +%s) - $(stat -c %Y "$RUN_DIR/events.jsonl" 2>/dev/null || stat -f %m "$RUN_DIR/events.jsonl")))
      if [ "$stalled" = 0 ] && [ "$age" -ge "$quiet" ] && ! tail -n 1 "$RUN_DIR/events.jsonl" | grep -q '"type":"wait","step":"[^"]*","state":"start"'; then
        stall_pause "$1" "$quiet"
        stalled=1
      fi
    fi
  done
  [ "$stalled" = 0 ] || ev resolved '"how":"progress"'
  return 0
}

# stall_pause <step id> <seconds quiet>: the watchdog's pause — what is known
# and nothing more. Written while the step runs, so one event under PIPE_BUF.
stall_pause() {
  local mins=$(($2 / 60)) doing quiet title text
  r_idx_plan "$1"; doing=$PD_DOING_CAP
  if [ "$mins" -ge 2 ]; then quiet="$mins minutes"; elif [ "$mins" = 1 ]; then quiet="a minute"; elif [ "$2" = 1 ]; then quiet="a second"; else quiet="$2 seconds"; fi
  P_STEP=$1 P_KIND=stall P_TITLE="No progress for $quiet" P_OPT=0 P_MANUAL=""
  # Its subject is the step's own words ("Starting equin's services"), never
  # "equin is <doing>": the doing already names equin.
  P_TEXT="${doing:-This step} hasn't shown any progress for $quiet. It may still finish, so the install keeps going. If it stays stuck, Fix with Claude can look at what it is doing."
  P_EV=("no output and no progress for ${2}s")
  write_pause_files
  json_str "$P_TITLE"; title=$JSON_STR
  json_str "$P_TEXT"; text=$JSON_STR
  ev pause "\"step\":\"$1\",\"kind\":\"stall\",\"title\":$title,\"text\":$text,\"evidence\":[\"no output and no progress for ${2}s\"],\"blocking\":false,\"optional\":false,\"manual\":null"
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
  # Which measured times this install shows (installer/core/internal/estimates.ts estimateSetOf):
  # on macOS the view decides how Apple's tools come in (the window: Apple's
  # dialog; the terminal: softwareupdate), on Linux every view runs apt.
  if [ "$OS" = "Darwin" ]; then
    if [ "$MODE" = "window" ]; then EST_SET=macos-window; else EST_SET=macos-terminal; fi
  else
    EST_SET=linux
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
  est="$(est_s "$EST_SET" "$1")"
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
  local dry=""
  [ "$DRY_RUN" != "1" ] || dry=',"dryRun":true'
  ev plan "\"release\":$release,\"platform\":\"$PLATFORM\",\"mode\":\"$MODE\"$dry,\"groups\":[$groups],\"steps\":[$steps]"
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
# (a retry) keeps its last time. A build sub-step (`build.*`) whose last word
# is skipped took 0 when the build ran to done — a fresh install's build finds
# main already built, and those zeros are what lets the window show a time
# left (timingFromEvents reads a stream the same way). `./equin installer
# estimates` takes the medians over these files.
write_timing() {
  local steps dry=false
  [ "$DRY_RUN" != "1" ] || dry=true
  steps="$(sed -n -e 's/^{"v":1,"t":"[^"]*","type":"step","id":"\([^"]*\)","state":"done","ms":\([0-9]*\)}$/\1 \2/p' \
    -e 's/^{"v":1,"t":"[^"]*","type":"step","id":"\(build\.[^"]*\)","state":"skipped"}$/\1 skipped/p' "$RUN_DIR/events.jsonl" |
    awk '{ if (!($1 in ms)) order[n++] = $1; ms[$1] = $2 }
      END {
        for (i = 0; i < n; i++) {
          id = order[i]; v = ms[id]
          if (v == "skipped") { if (!("build" in ms) || ms["build"] == "skipped") continue; v = 0 }
          printf "%s\"%s\":%s", (out++ ? "," : ""), id, v
        }
      }')"
  # The release and view the plan named: they tie the times to what ran
  # (`./equin installer estimates` keeps each view's apart).
  local release=null
  [ -z "$RELEASE" ] || release="\"$RELEASE\""
  printf '{"v":1,"dryRun":%s,"release":%s,"platform":"%s","mode":"%s","at":"%s","steps":{%s}}\n' \
    "$dry" "$release" "$PLATFORM" "$MODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$steps" >"$RUN_DIR/timing.json"
}

# run_step <id> <command…>: one top-level step. Emits its start, its output as
# log lines, then done or failed with how long it ran. A failed step is
# diagnosed and paused (`pause`): the person decides — retry runs it again
# (every step checks before it acts), quit gives up, skip leaves out an
# optional step (STEP_OPTIONAL=1). The command's own `./equin` reports
# (sub-steps, progress, waits) reach the hub through EQUIN_INSTALL_EVENTS; its
# own diagnosis of a failure through EQUIN_INSTALL_DIAGNOSIS (`own_diagnosis`)
# — when that names optional parts, Skip runs the step again without them
# (EQUIN_INSTALL_LEFT_OUT, which accumulates in LEFT_OUT).
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
    STEP_LOG0=$(wc -l <"$RUN_DIR/install.log")
    rm -f "$RUN_DIR/step-diagnosis"
    t0=$SECONDS
    set +e
    (
      eval "exec $CLOSE_FDS"
      export EQUIN_INSTALL_EVENTS="$FIFO" EQUIN_INSTALL_STEP="$id" \
        EQUIN_INSTALL_DIAGNOSIS="$RUN_DIR/step-diagnosis" EQUIN_INSTALL_LEFT_OUT="$LEFT_OUT"
      set -e
      "$@"
    ) 2>&1 | "$reader" "$id"
    STEP_RC=${PIPESTATUS[0]}
    set -e
    if [ "$STEP_RC" = "0" ]; then
      ev_step "$id" done "$(((SECONDS - t0) * 1000))"
      STEP_OPTIONAL=0
      return 0
    fi
    ev_step "$id" failed "$(((SECONDS - t0) * 1000))"
    diagnose "$id" "$STEP_RC"
    local optional=${STEP_OPTIONAL:-0}
    [ -z "$D_LEAVE_OUT" ] || optional=1
    pause "$id" "$D_KIND" "$D_TITLE" "$D_TEXT" "$optional" "$D_MANUAL" ${D_EV[@]+"${D_EV[@]}"}
    case "$DECISION" in
      retry) continue ;;
      # An optional PART of the step (its own diagnosis named it): the step
      # runs again without it, rather than being left out whole.
      skip) if [ -n "$D_LEAVE_OUT" ]; then
          LEFT_OUT="${LEFT_OUT:+$LEFT_OUT,}$D_LEAVE_OUT"
          ev_left_out
          continue
        fi
        ev_step "$id" skipped; STEP_RC=0 ;;
      *) PAUSE_QUIT=1 ;;
    esac
    STEP_OPTIONAL=0
    return 0
  done
}

# ── Diagnosis ────────────────────────────────────────────────────────────────
# What stopped a step, in the person's words. Each rule needs a symptom (in the
# step's exit or its last lines) AND a fact that confirms it, checked on the
# machine — one symptom alone gives confident wrong messages. No rule
# confirmed: `unknown`, which says only what is known. A stall is diagnosed
# while the step runs (ev_lines' watchdog; the build's wait reporting for the
# machine's build slot), never here.

# step_tail <n>: the last n lines this step wrote (install.log from its start).
step_tail() {
  tail -n "+$((STEP_LOG0 + 1))" "$RUN_DIR/install.log" | tail -n "$1" | sed $'s/\033\\[[0-9;?]*[a-zA-Z]//g'
}

# sandboxed: how this script can tell it runs in another app's protected
# mode, or nothing. macOS: a sandboxed process may not run a setuid program, so
# `ps` (setuid root) is refused — sandbox-exec execs the command it protects,
# leaving no parent to find, and this refusal is what the sandbox itself shows.
# An App Sandbox names its container. Linux: a bubblewrap or firejail parent.
sandboxed() {
  local out pid=$$ comm n=0
  if [ -n "${APP_SANDBOX_CONTAINER_ID:-}" ]; then
    echo "APP_SANDBOX_CONTAINER_ID=$APP_SANDBOX_CONTAINER_ID"; return 0
  fi
  if [ "$OS" = "Darwin" ]; then
    out="$(/bin/ps -o pid= -p $$ 2>&1 || true)"
    case "$out" in
      *"Operation not permitted"*) echo "/bin/ps: Operation not permitted (a protected shell refuses setuid programs)" ;;
    esac
    return 0
  fi
  while [ "$pid" -gt 1 ] && [ "$n" -lt 40 ] && [ -r "/proc/$pid/stat" ]; do
    comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"
    case "$comm" in bwrap|firejail) echo "a parent process is $comm"; return 0 ;; esac
    pid="$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null || echo 1)"
    n=$((n + 1))
  done
}

# security_agent: the name of the endpoint-security product running on this
# machine, as its maker calls it, or nothing. Read from the process list (no
# root needed); on a Mac, an enrolled device-management profile counts too.
security_agent() {
  local procs
  procs="$(ps -axo comm= 2>/dev/null | sed 's#.*/##')"
  case "$procs" in
    *JamfProtect*) echo "Jamf Protect" ;;
    *falcond*|*falcon-sensor*|*com.crowdstrike*) echo "CrowdStrike Falcon" ;;
    *SentinelAgent*|*sentineld*) echo "SentinelOne" ;;
    *wdavdaemon*|*mdatp*) echo "Microsoft Defender" ;;
    *SophosScan*|*SophosAntiVirus*|*sophos*) echo "Sophos" ;;
    *fsaua*|*fshoster*|*WithSecure*|*F-Secure*) echo "WithSecure" ;;
    *)
      if [ "$OS" = "Darwin" ] && profiles status -type enrollment 2>/dev/null | grep -q 'MDM enrollment: Yes'; then
        echo "the software your organisation manages this Mac with"
      fi ;;
  esac
}

# diagnose <step> <exit status>: D_KIND, D_TITLE, D_TEXT, D_MANUAL
# ("<id>|<label>" or empty) and D_EV (the evidence lines, `~` for the home
# folder) for a failed step.
diagnose() {
  local step=$1 rc=$2 tail who agent doing
  tail="$(step_tail 20)"
  r_idx_plan "$step"; doing=$PD_DOING
  D_MANUAL=""
  D_LEAVE_OUT=""
  D_WITHOUT=""
  D_LATER=""
  D_EV=()
  # Apple's installer closed without installing the tools (window mode).
  if [ "$step" = "tools" ] && [ "$OS" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
    D_KIND=unknown
    D_TITLE="Apple's developer tools weren't installed"
    D_TEXT="equin needs Apple's developer tools to download its code and build parts of itself, and Apple's installer closed before installing them. Try again opens it again: click Install and wait until it finishes (5 to 20 minutes). equin can't be installed without them."
    evidence_lines "$tail" 8
    D_EV+=("xcode-select -p: no developer tools found (step exit $rc)")
    return 0
  fi
  # The step's command said itself what failed (an optional part it could not
  # add, say): its words, in the person's terms — ahead of the rules below,
  # which read only the output's last lines.
  own_diagnosis && return 0
  # sandbox: killed outright (SIGKILL), under a sandboxing parent.
  if [ "$rc" = 137 ] || [ "$rc" = 9 ] || printf '%s\n' "$tail" | grep -qE 'SIGKILL|signal: 9|Killed: 9'; then
    who="$(sandboxed)"
    if [ -n "$who" ]; then
      sandbox_message
      evidence_lines "$(printf '%s\n' "$tail" | grep -E 'SIGKILL|signal: 9|Killed: 9|error' | tail -n 3 || true)" 3
      D_EV+=("step exit $rc (killed)" "$who")
      return 0
    fi
  fi
  # security: one of equin's own programs vanished or was refused right after
  # it was made, with a security product running.
  if printf '%s\n' "$tail" | grep -qE '(\.equin|/equin)[^ ]*.*(no such file or directory|No such file or directory|Operation not permitted|ENOENT|EPERM)'; then
    agent="$(security_agent)"
    if [ -n "$agent" ]; then
      D_KIND=security
      D_TITLE="Your company's security software removed part of equin"
      D_TEXT="equin builds small programs on this computer to run itself, and $agent, which your organisation runs here, removed or blocked one right after it was made, so equin can't start. Your IT team can allow equin's folders: Copy request for IT gives you a message to send them. Until then equin can't be installed."
      D_MANUAL="copy-it-request|Copy request for IT"
      evidence_lines "$(printf '%s\n' "$tail" | grep -E 'no such file or directory|No such file or directory|Operation not permitted|ENOENT|EPERM' | tail -n 3 || true)" 3
      D_EV+=("security software running: $agent")
      return 0
    fi
  fi
  D_KIND=unknown
  r_idx_plan "$step"
  D_TITLE="${PD_DOING_CAP:-$PD_LABEL} didn't finish"
  D_TEXT="equin stopped while ${doing:-working}: the last lines it printed are below. Fix with Claude reads the whole log and explains what went wrong before changing anything. Trying again picks up where it stopped."
  evidence_lines "$tail" 20
  D_EV+=("step exit $rc")
}

# own_diagnosis: the failed step's command's own diagnosis, when it wrote one
# (installer/cli reportInstallDiagnosis: `key<TAB>value` lines — title, text,
# leave-out, evidence…) into EQUIN_INSTALL_DIAGNOSIS. Sets D_* like diagnose;
# 1 when there is none. Its title and text already follow the message rules.
own_diagnosis() {
  local file="$RUN_DIR/step-diagnosis" k v
  [ -s "$file" ] || return 1
  D_KIND=unknown D_TITLE="" D_TEXT=""
  while IFS=$'\t' read -r k v; do
    case "$k" in
      title) D_TITLE=$v ;;
      text) D_TEXT=$v ;;
      leave-out) D_LEAVE_OUT=$v ;;
      without) D_WITHOUT=$v ;;
      later) D_LATER=$v ;;
      evidence) redact "$v"; D_EV+=("${RD:0:300}") ;;
    esac
  done <"$file"
  [ -n "$D_TITLE" ] && [ -n "$D_TEXT" ] || { D_LEAVE_OUT=""; D_WITHOUT=""; D_LATER=""; D_EV=(); return 1; }
  return 0
}

# ev_left_out: the record of a Skip that left an optional part out (the
# diagnosis's leave-out ids, `without`, `later`) — a `notice` sent right after
# the pause's `resolved skip`, before the step runs again: renderers read a
# notice that answers a Skip as the person's choice (no banner, nothing to
# allow), and the done screen names it with what it means. done_wait never
# offers to add it (its id is in LEFT_OUT).
ev_left_out() {
  # Cut so the event stays one write under PIPE_BUF, like a log line.
  local without=${D_WITHOUT:-what this step could not add} later=${D_LATER:-}
  without=${without:0:90} later=${later:0:200}
  json_str "$D_LEAVE_OUT"; local id=$JSON_STR
  json_str "Installed without $without"; local title=$JSON_STR
  json_str "${later:-equin works without it, in your browser.}"; local text=$JSON_STR
  json_str "$without"; local w=$JSON_STR
  ev notice "\"id\":$id,\"state\":\"skipped\",\"title\":$title,\"text\":$text,\"without\":$w"
}

# sandbox_check: before any step, the sandbox rule's fact on its own — a
# sandboxing parent, or (inside Claude Code) a write outside the project
# refused. A refused write is certain to stop the install, so it can't be
# skipped; a sandboxing parent may allow what the install does, so Skip tries
# anyway.
sandbox_check() {
  local refused who opt
  while :; do
    refused=""
    who="$(sandboxed)"
    [ -z "${CLAUDECODE:-}" ] || refused="$(refused_write_dir)"
    [ -n "$who$refused" ] || return 0
    sandbox_message
    D_EV=()
    if [ -n "$refused" ]; then
      redact "creating and renaming a file in $refused was refused (CLAUDECODE is set)"; D_EV+=("$RD")
    fi
    [ -z "$who" ] || D_EV+=("$who")
    opt=1
    [ -z "$refused" ] || opt=0
    pause "" sandbox "$D_TITLE" "$D_TEXT" "$opt" "$D_MANUAL" "${D_EV[@]}"
    case "$DECISION" in
      retry) continue ;;
      skip) return 0 ;;
      *) PAUSE_QUIT=1; exit 1 ;;
    esac
  done
}

# after_pause <fix|report>: --fix / --report, on the last install's pause.
after_pause() {
  local run url dir="$HOME"
  run="$(data_root)/logs/install/latest"
  if [ ! -f "$run/diagnosis.json" ]; then
    echo "The last equin install didn't stop on a problem, so there is nothing to $1. To install equin, run the installer again." >&2
    exit 1
  fi
  if [ "$1" = report ]; then
    url="$(cat "$run/report-url")"
    printf '\n  Report this issue: this link opens a new GitHub issue with what happened filled in\n  (your home folder shown as ~, your account and computer names removed).\n  Nothing is sent until you submit it there.\n\n  %s\n\n' "$url"
    if [ "$OS" = "Darwin" ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then open_thing "$url" 2>/dev/null || true; fi
    exit 0
  fi
  if [ -t 0 ] && [ -t 1 ]; then exec bash "$run/fix.command"; fi
  if [ "$YES" != "1" ]; then
    echo "install.sh --fix: there is no terminal here, so Claude could not ask before each command it runs. Run it in a terminal, or add --yes to let Claude act without asking (it is told never to touch security software)." >&2
    exit 2
  fi
  export PATH="$HOME/.local/bin:$PATH"
  command -v claude >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash
  [ ! -d "$INSTALL_DIR" ] || dir=$INSTALL_DIR
  cd "$dir"
  exec claude -p --permission-mode bypassPermissions "$(cat "$run/fix-prompt.md")"
}

# sandbox_message: the sandbox diagnosis's words (a failed step and the check
# before any step say the same).
sandbox_message() {
  D_KIND=sandbox
  D_TITLE="Blocked by the app you started it from"
  D_TEXT="The install builds parts of equin on your computer, and the app you ran it from runs commands in a protected mode that doesn't allow that, so it would stop part-way. Run it from the Terminal app instead: Continue in Terminal does it for you, and the install picks up where it stopped."
  D_MANUAL="continue-in-terminal|Continue in Terminal"
}

# evidence_lines <text> <max>: append up to max of its non-empty lines to
# D_EV, the home folder as `~` and the account and machine names removed.
evidence_lines() {
  local line n=0
  while IFS= read -r line; do
    [ -n "${line//[[:space:]]/}" ] || continue
    redact "$line"
    D_EV+=("${RD:0:300}")
    n=$((n + 1))
    [ "$n" -lt "$2" ] || break
  done <<EOF_LINES
$1
EOF_LINES
}

# redact <text>: RD = the text with $HOME as ~, the account and host names out.
redact() {
  local user host
  RD=$1
  RD=${RD//"$HOME"/\~}
  user="$(id -un 2>/dev/null || true)"
  host="$(hostname -s 2>/dev/null || true)"
  [ -z "$user" ] || [ "${#user}" -lt 3 ] || RD=${RD//"$user"/<user>}
  [ -z "$host" ] || [ "${#host}" -lt 3 ] || RD=${RD//"$host"/<host>}
}

# r_idx_plan <step id>: PD_LABEL / PD_DOING (lower-cased) from the plan.
r_idx_plan() {
  local i
  PD_LABEL=$1; PD_DOING=""; PD_DOING_CAP=""
  for ((i = 0; i < ${P_N:-0}; i++)); do
    if [ "${P_ID[i]}" = "$1" ]; then
      PD_LABEL=${P_LABEL[i]}
      PD_DOING_CAP=${P_DOING[i]}
      PD_DOING="$(printf '%s' "${P_DOING[i]:0:1}" | tr '[:upper:]' '[:lower:]')${P_DOING[i]:1}"
      return 0
    fi
  done
}

# ── Pause, and the decisions that answer it ──────────────────────────────────
# pause <step|""> <kind> <title> <text> <optional 0|1> <manual "id|label"|"">
# [evidence…]: tell the views (a `pause` event), leave what Fix with Claude and
# Report issue need beside the log, and wait for a decision. Sets DECISION:
# retry, skip (only when optional) or quit. In the window the decisions come on
# fd 4; in an interactive terminal from keys; in plain mode there is no one to
# ask: the view prints the next commands and the install stops (quit).
# Claude's `resume` (and Try again) write `retry` to the control FIFO.
pause() {
  P_STEP=$1 P_KIND=$2 P_TITLE=$3 P_TEXT=$4 P_OPT=$5 P_MANUAL=$6
  shift 6
  P_EV=(${@+"$@"})
  write_pause_files
  ev_pause
  if [ "$MODE" = "plain" ]; then DECISION=quit; return 0; fi
  # The window's Fix with Claude never reaches here (its forwarder does it).
  local allowed="retry quit"
  [ "$P_OPT" != "1" ] || allowed="$allowed skip"
  [ "$MODE" != "interactive" ] || allowed="$allowed fix-cli report log${P_MANUAL:+ manual}"
  while :; do
    [ "$MODE" != "interactive" ] || start_keys
    read_decision $allowed
    case "$DECISION" in
      retry|quit|skip)
        stop_keys
        ev resolved "\"how\":\"$DECISION\""
        return 0 ;;
      fix-cli) # the terminal: Claude Code runs right here
        stop_keys
        : >"$RUN_DIR/pause-printed"
        ev fixing '"target":"cli","clipboard":false'
        bash "$RUN_DIR/fix.command" </dev/tty >/dev/tty 2>&1 || true
        ev_pause ;; # back to the choice, unless Claude said to resume (read next)
      # Each prints below the pause's box: the view then keeps the box (and
      # what was printed) above the block it draws next (pause-printed).
      manual) stop_keys; : >"$RUN_DIR/pause-printed"; do_manual ;;
      report) stop_keys; : >"$RUN_DIR/pause-printed"; term_report ;;
      log) stop_keys; : >"$RUN_DIR/pause-printed"; term_log ;;
    esac
  done
}

# read_decision <word…>: DECISION = the next decision on the control FIFO that
# is one of the words. `eof` (the window closed) is quit.
#
# Read a tick at a time, never in one blocking `read`: bash >= 5 can miss a
# trapped signal (the window's Stop, Ctrl-C) that lands just as `read` starts —
# it then waits for the next line, so a paused install ignored its Stop until
# a decision came (1 run in 20 under bash 5.2; never under 3.2). A `read -t`
# that times out runs the pending trap, so a Stop takes effect within a second.
read_decision() {
  local line w rc
  DECISION=quit
  RL_PART=""
  while :; do
    rc=0; read_tick 1 <&"$CF_FD" || rc=$?
    [ "$rc" != 2 ] || continue
    [ "$rc" = 0 ] || return 0 # EOF
    line=$RL_LINE
    [ "$line" != "eof" ] || return 0
    for w in "$@"; do
      if [ "$line" = "$w" ]; then DECISION=$line; return 0; fi
    done
    # Printed below a pause's menu: the view keeps it (and the box) above
    # the block it draws next rather than erasing a row it did not count.
    [ -z "$RUN_DIR" ] || : >"$RUN_DIR/pause-printed"
    echo "install.sh: ignored a decision it does not take now: $line" >&2
  done
  return 0
}

# ev_pause: the pause event, from P_*.
ev_pause() {
  local ev_json="" e step=null manual=null
  for e in ${P_EV[@]+"${P_EV[@]}"}; do
    json_str "$e"; ev_json="$ev_json${ev_json:+,}$JSON_STR"
  done
  [ -z "$P_STEP" ] || step="\"$P_STEP\""
  if [ -n "$P_MANUAL" ]; then
    json_str "${P_MANUAL#*|}"
    manual="{\"id\":\"${P_MANUAL%%|*}\",\"label\":$JSON_STR}"
  fi
  local title text opt=false
  json_str "$P_TITLE"; title=$JSON_STR
  json_str "$P_TEXT"; text=$JSON_STR
  [ "$P_OPT" != "1" ] || opt=true
  ev pause "\"step\":$step,\"kind\":\"$P_KIND\",\"title\":$title,\"text\":$text,\"evidence\":[$ev_json],\"blocking\":true,\"optional\":$opt,\"manual\":$manual"
}

# write_pause_files: beside the log, what acting on the pause needs —
# diagnosis.json (the pause), fix-prompt.md (the problem, the system and the
# log's last 150 lines, for Claude), fix.command (opens Claude Code with it,
# installing Claude Code first when it is missing) and report-url (the issue
# link `--report` and the terminal print).
write_pause_files() {
  local e label=$P_STEP doing="" ev_md="" again
  r_idx_plan "$P_STEP"; [ -z "$P_STEP" ] || { label=$PD_LABEL; doing=$PD_DOING; }
  for e in ${P_EV[@]+"${P_EV[@]}"}; do ev_md="$ev_md$e"$'\n'; done
  {
    printf '{"kind":"%s","step":"%s","title":' "$P_KIND" "$P_STEP"
    json_str "$P_TITLE"; printf '%s,"text":' "$JSON_STR"
    json_str "$P_TEXT"; printf '%s,"evidence":[' "$JSON_STR"
    local first=1
    for e in ${P_EV[@]+"${P_EV[@]}"}; do
      json_str "$e"; [ "$first" = 1 ] || printf ','; printf '%s' "$JSON_STR"; first=0
    done
    printf ']}\n'
  } >"$RUN_DIR/diagnosis.json"
  {
    echo "# Help me finish installing equin"
    echo
    echo "I was installing equin ($CANONICAL_REPO_URL), an app that runs on my computer, and its installer stopped."
    echo
    echo "## What the installer says"
    echo
    echo "**$P_TITLE**"
    echo
    echo "$P_TEXT"
    echo
    echo '```'
    printf '%s' "$ev_md"
    echo '```'
    echo
    echo "## Where it stopped"
    echo
    if [ -n "$P_STEP" ]; then echo "- Step: $label ($doing)"; else echo "- Before the first step"; fi
    echo "- System: ${SYS_DESC:-$OS}; installing ${WHAT:-equin} into ${INSTALL_DIR:-~/equin}"
    echo "- The full log: $RUN_DIR/install.log (every install event: $RUN_DIR/events.jsonl). Its last 150 lines:"
    echo
    echo '```'
    tail -n 150 "$RUN_DIR/install.log"
    echo '```'
    echo
    echo "## How to help"
    echo
    echo "- First explain what went wrong, in plain words, before changing anything."
    echo "- Ask me before each command that changes my computer."
    echo "- Never disable, remove or get around security software. If the fix needs me (a setting only I can change) or my IT team, say so plainly and stop there."
    echo "- Once it is fixed, run \`$RESUME\`: the installer is waiting and carries on from where it stopped (if it has stopped waiting, the same command starts it again)."
  } >"$RUN_DIR/fix-prompt.md"
  local dir="$HOME"
  [ ! -d "${INSTALL_DIR:-}" ] || dir=$INSTALL_DIR
  {
    echo '#!/bin/bash'
    echo "# Fix with Claude: Claude Code, started with what stopped the equin install."
    echo "cd $(q "$dir") || exit 1"
    echo 'export PATH="$HOME/.local/bin:$PATH"'
    echo 'if ! command -v claude >/dev/null 2>&1; then'
    echo '  echo "Installing Claude Code (Anthropic'"'"'s official installer)…"'
    echo '  curl -fsSL https://claude.ai/install.sh | bash || exit 1'
    echo 'fi'
    echo "exec claude \"\$(cat $(q "$RUN_DIR/fix-prompt.md"))\""
  } >"$RUN_DIR/fix.command"
  chmod +x "$RUN_DIR/fix.command"
  report_url
  printf '%s\n' "$RU" >"$RUN_DIR/report-url"
}

# q <text>: the text single-quoted for a shell.
q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }

# write_resume: ~/.equin/logs/install/resume — what Claude runs once it fixed
# the problem: `retry` to the install waiting now, or the install run again
# when none is (it resumes where the last one stopped).
write_resume() {
  local root again
  root="$(data_root)/logs/install"
  RESUME="$root/resume"
  # A dry run touches nothing but its own run dir.
  [ "$DRY_RUN" != "1" ] || RESUME="$RUN_DIR/resume"
  if [ -n "${SELF_DIR:-}" ] || [ -d "${INSTALL_DIR:-/nonexistent}/.git" ]; then
    again="cd $(q "$INSTALL_DIR") && exec ./install.sh"
  else
    again="curl -fsSL https://raw.githubusercontent.com/equinai/equin/main/install.sh | bash"
  fi
  cat >"$RESUME" <<EOF_RESUME
#!/bin/bash
# Continue the equin install: tell the one waiting to try again, or run it again.
run=$(q "$root")/latest
pid="\$(cat "\$run/pid" 2>/dev/null)"
if [ -n "\$pid" ] && kill -0 "\$pid" 2>/dev/null && [ -p "\$run/control.fifo" ]; then
  printf 'retry\n' >"\$run/control.fifo"
  echo "The equin installer is trying again; its window (or terminal) shows how it goes."
else
  echo "The equin installer isn't running: starting it again. It picks up where it stopped."
  $again
fi
EOF_RESUME
  chmod +x "$RESUME"
}

# clipboard_put: stdin onto the clipboard; fails when there is no way to.
clipboard_put() {
  if command -v pbcopy >/dev/null 2>&1; then pbcopy
  elif [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then wl-copy
  elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard
  elif command -v xsel >/dev/null 2>&1; then xsel -b -i
  else return 1; fi
}

# open_thing <file|url>: open it as a double-click would.
open_thing() {
  if [ "$OS" = "Darwin" ]; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"
  else return 1; fi
}

# fix_app: the prompt on the clipboard, then the Claude app (on Linux, where
# there is none, claude.ai in the browser). The app has no supported way to
# open with a prompt filled in, so the person pastes it.
fix_app() {
  local copied=false
  if clipboard_put <"$RUN_DIR/fix-prompt.md" 2>/dev/null; then copied=true; fi
  if [ "$OS" = "Darwin" ] && open -a Claude 2>/dev/null; then :
  else open_thing "https://claude.ai/new" 2>/dev/null || true; fi
  ev fixing "\"target\":\"app\",\"clipboard\":$copied"
  [ "$copied" = true ] || log_line "" "Fix with Claude: there is no clipboard tool here (pbcopy, wl-copy, xclip or xsel): paste the contents of $RUN_DIR/fix-prompt.md into Claude."
}

# fix_cli: fix.command in a new terminal window. On macOS `open` on a
# .command file opens it in Terminal without asking for any permission
# (scripting Terminal would).
fix_cli() {
  local term found=""
  if [ "$OS" = "Darwin" ]; then
    open "$RUN_DIR/fix.command" || { log_line "" "Fix with Claude: Terminal did not open; run $RUN_DIR/fix.command in a terminal."; return 0; }
  else
    for term in "${TERMINAL:-}" x-terminal-emulator gnome-terminal konsole xterm; do
      [ -n "$term" ] && command -v "$term" >/dev/null 2>&1 || continue
      if [ "$term" = gnome-terminal ]; then "$term" -- bash "$RUN_DIR/fix.command" & else "$term" -e bash "$RUN_DIR/fix.command" & fi
      found=$term
      break
    done
    if [ -z "$found" ]; then log_line "" "Fix with Claude: no terminal app found; run $RUN_DIR/fix.command in one."; return 0; fi
  fi
  ev fixing "\"target\":\"cli\",\"clipboard\":false"
}

# show_claude: bring Claude back to the front.
show_claude() {
  [ "$OS" = "Darwin" ] || return 0
  open -a Claude 2>/dev/null || open -a Terminal 2>/dev/null || true
}

# do_manual: the pause's own action (P_MANUAL).
do_manual() {
  case "${P_MANUAL%%|*}" in
    continue-in-terminal)
      local again
      if [ -n "${SELF_DIR:-}" ]; then again="cd $(q "$INSTALL_DIR") && ./install.sh"
      else again="curl -fsSL https://raw.githubusercontent.com/equinai/equin/main/install.sh | bash"; fi
      printf '#!/bin/bash\n%s\n' "$again" >"$RUN_DIR/continue.command"
      chmod +x "$RUN_DIR/continue.command"
      if [ "$OS" = "Darwin" ] && open "$RUN_DIR/continue.command" 2>/dev/null; then
        tty_say "The install continues in a new Terminal window. You can close this one."
      else
        tty_say "Open the Terminal app and run:" "" "    $again"
      fi ;;
    copy-it-request)
      local msg
      msg="Hi, I'm installing equin (an open-source app that runs on my computer, $CANONICAL_REPO_URL). Our security software removes the programs it builds on my machine. Could you allow the folders $(data_root) and ${INSTALL_DIR:-~/equin} for my account? System: ${SYS_DESC:-$OS}. What the installer saw: ${P_EV[*]:-}"
      redact "$msg"; msg=$RD
      printf '%s\n' "$msg" >"$RUN_DIR/it-request.txt"
      if printf '%s\n' "$msg" | clipboard_put 2>/dev/null; then
        tty_say "A message for your IT team is on your clipboard (also saved as $RUN_DIR/it-request.txt):" "" "$msg"
      else
        tty_say "A message for your IT team, saved as $RUN_DIR/it-request.txt:" "" "$msg"
      fi ;;
  esac
}

# tty_say <line…>: lines for the person at the terminal, below the paused view.
tty_say() {
  local l
  printf '\n' >/dev/tty
  for l in "$@"; do printf '  %s\n' "$l" >/dev/tty; done
}

# term_report: the issue link, printed (and opened when there is a screen).
term_report() {
  tty_say "Report this issue: this link opens a new GitHub issue with what happened filled in (your home folder shown as ~, your account and computer names removed). Nothing is sent until you submit it there." "" "$(cat "$RUN_DIR/report-url")"
  if [ "$OS" = "Darwin" ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then open_thing "$(cat "$RUN_DIR/report-url")" 2>/dev/null || true; fi
}

term_log() {
  local l
  printf '\n' >/dev/tty
  tail -n 40 "$RUN_DIR/install.log" | while IFS= read -r l; do printf '  \033[2m│ %s\033[0m\n' "$l" >/dev/tty; done
  printf '  \033[2mlog: %s\033[0m\n' "$RUN_DIR/install.log" >/dev/tty
}

# start_keys / stop_keys: in an interactive terminal, a key read from the
# terminal becomes a decision on the control FIFO.
start_keys() {
  [ -z "$KEYS_PID" ] || return 0
  (
    trap 'exit 0' TERM
    while IFS= read -r -s -n 1 k </dev/tty; do
      case "$k" in
        t) w=retry ;; f) w=fix-cli ;; r) w=report ;; l) w=log ;;
        q) w=quit ;; s) w=skip ;; m) w=manual ;; *) continue ;;
      esac
      printf '%s\n' "$w" >&"$CF_FD"
    done
  ) &
  KEYS_PID=$!
}

stop_keys() {
  [ -n "$KEYS_PID" ] || return 0
  kill "$KEYS_PID" 2>/dev/null || true
  wait "$KEYS_PID" 2>/dev/null || true
  KEYS_PID=""
  # A raw-mode read cut short leaves the terminal as it was set: restore it.
  stty sane </dev/tty 2>/dev/null || true
}

# report_url: RU = the GitHub new-issue link for the pause (P_*), built here
# for the terminal and `--report` (the window builds its own from the same
# event, with installer/core's installIssueUrl). Labelled install; the body
# is cut to stay well under GitHub's link limit.
report_url() {
  local body e
  body="$P_TEXT"$'\n\n```\n'
  for e in ${P_EV[@]+"${P_EV[@]}"}; do body="$body$e"$'\n'; done
  body="$body"$'```\n\n'"System: ${SYS_DESC:-$OS} · release ${RELEASE:-main}"$'\n'"The full log is at ~/.equin/logs/install/latest/install.log: drag it here to attach it."
  redact "$body"; body=${RD:0:2500}
  urlencode "Install: $P_TITLE"; local t=$UE
  urlencode "$body"
  RU="$CANONICAL_REPO_URL/issues/new?labels=install&title=$t&body=$UE"
}

# urlencode <text>: UE = the text percent-encoded, byte by byte.
urlencode() {
  local LC_ALL=C s=$1 i c hex n
  UE=""
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case "$c" in
      [a-zA-Z0-9.~_-]) UE="$UE$c" ;;
      *) # a byte's value; bash reads one above 127 as negative
        printf -v n '%d' "'$c"
        [ "$n" -ge 0 ] || n=$((n + 256))
        printf -v hex '%%%02X' "$n"; UE="$UE$hex" ;;
    esac
  done
}

# done_wait: in the window, after done, while an optional part the install
# went on without (a `notice`, from `./equin start`) is still left out: Add it
# now opens the setting that allows it, then adds it (`./equin start --only
# <id>`). Closing the window (quit) ends the install, which is done anyway.
done_wait() {
  [ "$MODE" = "window" ] || return 0
  local line id opened=0 before
  # The last notice of a part macOS refused — not one the person chose to
  # leave out with Skip (its id is in LEFT_OUT: nothing to allow, nothing
  # to add here).
  local l lid
  line=""
  while IFS= read -r l; do
    lid=${l#*\"id\":\"}; lid=${lid%%\"*}
    case ",$LEFT_OUT," in *",$lid,"*) continue ;; esac
    line=$l
  done < <(grep '"type":"notice"' "$RUN_DIR/events.jsonl" || true)
  case "$line" in '' | *'"state":"added"'*) return 0 ;; esac
  id=${line#*\"id\":\"}; id=${id%%\"*}
  while :; do
    read_decision add-services quit
    [ "$DECISION" = "add-services" ] || return 0
    if [ "$opened" = 0 ]; then
      if [ "$DRY_RUN" = "1" ]; then dry_notice settings-opened
      else
        open_thing "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppBundles" 2>/dev/null || true
        ev notice "\"id\":\"$id\",\"state\":\"settings-opened\",\"title\":\"macOS blocked equin from adding its apps\",\"text\":\"Turn on Terminal in Privacy & Security, App Management, then click Add them.\",\"without\":\"the menu-bar icon and app shortcuts\""
      fi
      opened=1
      continue
    fi
    if [ "$DRY_RUN" = "1" ]; then dry_notice added; return 0; fi
    before=$(grep -c '"type":"notice"' "$RUN_DIR/events.jsonl" || true)
    set +e
    (
      eval "exec $CLOSE_FDS"
      export EQUIN_INSTALL_EVENTS="$FIFO" EQUIN_INSTALL_STEP=start
      ./equin start --only "$id"
    ) 2>&1 | while IFS= read -r line; do log_line "" "$line"; done
    set -e
    # Refused again: start said so with a new notice (skipped); else it's in.
    if [ "$(grep -c '"type":"notice"' "$RUN_DIR/events.jsonl" || true)" = "$before" ]; then
      ev notice "\"id\":\"$id\",\"state\":\"added\",\"title\":\"macOS blocked equin from adding its apps\",\"text\":\"Added after all.\",\"without\":\"the menu-bar icon and app shortcuts\""
      return 0
    fi
    opened=0
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
  # The dry run's view exits (status 7) at that step's start, to prove a
  # view that dies stops the install loudly (view_ended).
  local dry_exit=""
  [ "$DRY_RUN" != "1" ] || dry_exit=${EQUIN_INSTALL_DRY_RUN_VIEW_EXIT:-}
  r_init
  RL_PART=""
  while :; do
    # A 1 s timeout (bash 3.2 takes whole seconds) ticks the spinner and the
    # clocks; read_tick tells it from EOF under every bash.
    if read_tick 1; then
      case "$RL_LINE" in *"\"id\":\"$dry_exit\",\"state\":\"start\""*) [ -z "$dry_exit" ] || exit 7 ;; esac
      r_event "$RL_LINE"
    elif [ $? = 1 ]; then
      [ -z "$RL_LINE" ] || r_event "$RL_LINE"
      break
    fi
    [ "$MODE" != "interactive" ] || r_maybe_draw
  done
  r_finish
  # The stream ended before the install said it ended: view_ended says so.
  [ -n "$R_EXIT" ] || return 3
}

# view_ended <the terminal view's status>: in the hub, once the view ended.
# 0: it drew the exit event, the install is over. Anything else, the view ended
# while the install runs — which used to kill the install without a word (tee,
# then install.sh, died of SIGPIPE on their next write). Now it is loud: the
# cause on stderr at once, and in view-ended for on_exit (the exit event's
# `cause`, the failure message); the install is stopped as Ctrl-C would (TERM,
# taken by bash between commands: a step command already running finishes
# first), since its pauses cannot be answered without the view; and the
# stream is drained into events.jsonl until it ends, so no writer dies of
# SIGPIPE on the way.
view_ended() {
  [ "$1" != 0 ] || return 0
  local cause
  if [ "$1" = 3 ]; then
    cause="the terminal view's event stream ended before the install's exit event"
  else
    cause="the terminal view stopped (status $1) while the install was running"
  fi
  printf '%s\n' "$cause" >"$RUN_DIR/view-ended"
  printf '\ninstall.sh: %s, so the install stops. Its log: %s\n' \
    "$cause" "$RUN_DIR/install.log" >&2
  kill -TERM "$$" 2>/dev/null
  [ ! -f "$RUN_DIR/attached-pid" ] || kill -TERM "$(cat "$RUN_DIR/attached-pid")" 2>/dev/null
  cat >/dev/null
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
  R_P_OPEN=0; R_N_STATE=""; R_SKIPPING=0; R_LO=(); R_LOT=()
  # What the person runs to act on a stop: the checkout's script, or the curl.
  if [ -n "${SELF_DIR:-}" ]; then R_AGAIN="./install.sh"
  else R_AGAIN="curl -fsSL https://raw.githubusercontent.com/equinai/equin/main/install.sh | bash -s --"; fi
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
    # The terminal's title says what runs, not the script's command line
    # (the terminal's own title saved on its title stack, restored at the end).
    printf '\033[22;0t\033]0;equin installer\007'
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
      R_SKIPPING=0
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
        [ "$R_N_STATE" != "skipped" ] || r_plain "installed without $R_N_WITHOUT · once Terminal is allowed in App Management: ./equin start --only $R_N_ID"
      fi ;;
    exit) r_num code "$l"; R_EXIT=$F ;;
    pause) r_on_pause "$l" ;;
    resolved) r_str how "$l"; r_on_resolved "$F" ;;
    fixing) r_on_fixing ;;
    notice) r_on_notice "$l" ;;
  esac
}

# r_jstr <key> <event>: JS = the key's JSON string value, unescaped (the
# escapes json_str and JSON.stringify write: \" \\ \t \n \r \uXXXX for ESC).
r_jstr() {
  local rest=${2#*\"$1\":\"}
  JS=""
  [ "$rest" != "$2" ] || return 1
  r_jtake "$rest"
}

# r_jtake <text after an opening quote>: JS = the string up to its closing
# quote, unescaped; JREST = what follows it.
r_jtake() {
  local t=$1 c out="" i=0 n=${#1}
  while [ "$i" -lt "$n" ]; do
    c=${t:i:1}
    if [ "$c" = '"' ]; then break; fi
    if [ "$c" = "\\" ]; then
      i=$((i + 1)); c=${t:i:1}
      case "$c" in
        n) c=" " ;; t) c=" " ;; r) c="" ;;
        u) c=""; i=$((i + 4)) ;;
      esac
    fi
    out="$out$c"
    i=$((i + 1))
  done
  JS=$out
  JREST=${t:i+1}
}

# r_jarr <key> <event>: JA = the key's array of JSON strings.
r_jarr() {
  local rest=${2#*\"$1\":[}
  JA=()
  [ "$rest" != "$2" ] || return 0
  while [ "${rest:0:1}" = '"' ]; do
    r_jtake "${rest:1}"
    JA[${#JA[@]}]=$JS
    rest=$JREST
    [ "${rest:0:1}" = "," ] || break
    rest=${rest:1}
  done
}

# r_wrap <text> <width>: WR = the text in lines of at most width characters.
r_wrap() {
  local w word line=""
  WR=()
  for word in $1; do
    if [ -n "$line" ] && [ $((${#line} + 1 + ${#word})) -gt "$2" ]; then
      WR[${#WR[@]}]=$line; line=$word
    else
      line="${line:+$line }$word"
    fi
  done
  [ -z "$line" ] || WR[${#WR[@]}]=$line
}

r_on_pause() {
  local l=$1
  r_jstr title "$l"; R_P_TITLE=$JS
  r_jstr text "$l"; R_P_TEXT=$JS
  r_str kind "$l"; R_P_KIND=$F
  r_jarr evidence "$l"; R_P_EV=(${JA[@]+"${JA[@]}"})
  R_P_MANUAL=""
  case "$l" in *'"manual":{'*) r_jstr label "${l#*\"manual\":}"; R_P_MANUAL=$JS ;; esac
  R_P_OPT=0
  case "$l" in *'"optional":true'*) R_P_OPT=1 ;; esac
  R_P_BLOCK=1
  case "$l" in *'"blocking":false'*) R_P_BLOCK=0 ;; esac
  R_P_OPEN=1
  R_FORCE=1
  if [ "$MODE" = "plain" ]; then
    local k word=FAILED
    [ "$R_P_BLOCK" = 1 ] || word=PAUSED
    r_plain "$word: $R_P_TITLE"
    r_wrap "$R_P_TEXT" 96; for k in ${WR[@]+"${WR[@]}"}; do r_plain "  $k"; done
    for k in ${R_P_EV[@]+"${R_P_EV[@]}"}; do r_plain "  > $k"; done
    if [ "$R_P_BLOCK" = 1 ]; then
      r_plain "next:"
      r_plain "  $R_AGAIN --fix      Claude Code reads the log and helps fix it, asking before each command (--yes: without asking)"
      r_plain "  $R_AGAIN --report   a GitHub issue with what happened (nothing is sent until you submit it)"
      r_plain "  $R_AGAIN            try again: it picks up where it stopped"
      r_plain "diagnosis: $R_DATA/logs/install/latest/diagnosis.json ($R_P_KIND)"
    fi
    return 0
  fi
  [ "$R_P_BLOCK" = 1 ] || return 0 # drawn inside the block, which keeps redrawing
  # Blocking: the block's last frame, then the box and the choices below it;
  # no redraw until it is answered (keys, and Claude, print below it).
  R_PAUSED=0; r_draw; R_PAUSED=1
  rm -f "$RUN_DIR/pause-printed"
  r_box
  local out="" line
  for line in ${R_BOX[@]+"${R_BOX[@]}"}; do out="$out$line"$'\n'; done
  out="$out"$'\n'"${C_B}  What now?${C_0}"$'\n'
  out="$out  ${C_B}[t]${C_0} Try again            ${C_D}picks up where it stopped${C_0}"$'\n'
  out="$out  ${C_B}[f]${C_0} Fix with Claude      ${C_D}Claude Code reads the log and helps, asking before each command${C_0}"$'\n'
  [ -z "$R_P_MANUAL" ] || out="$out  ${C_B}[m]${C_0} $(printf '%-20s' "$R_P_MANUAL") ${C_D}$(r_manual_hint)${C_0}"$'\n'
  [ "$R_P_OPT" != 1 ] || out="$out  ${C_B}[s]${C_0} Skip                 ${C_D}go on without it${C_0}"$'\n'
  out="$out  ${C_B}[r]${C_0} Report this issue    ${C_D}a GitHub issue with what happened; nothing is sent until you submit it${C_0}"$'\n'
  out="$out  ${C_B}[l]${C_0} Show the full log"$'\n'
  out="$out  ${C_B}[q]${C_0} Quit                 ${C_D}running the installer again picks up where it stopped${C_0}"$'\n'
  printf '%s' "$out"
  # The rows the frame, box and menu take: a Try again or Skip answered with
  # nothing else printed erases them all and redraws the block in place.
  r_rows "$out"; R_PH=$((R_H + RR))
}

# r_rows <text>: RR = the terminal rows the text's lines take (a line longer
# than the terminal wraps onto more), as r_flush counts them.
r_rows() {
  local line vis cols=$R_COLS
  [ "$cols" -gt 0 ] || cols=80
  RR=0
  while IFS= read -r line; do
    vis=${line//$'\033'\[*([0-9;])m/}
    if [ "${#vis}" -le 1 ]; then RR=$((RR + 1)); else RR=$((RR + (${#vis} - 1) / cols + 1)); fi
  done <<<"${1%$'\n'}"
}

r_manual_hint() {
  case "$R_P_MANUAL" in
    "Continue in Terminal") printf 'runs the install again in the Terminal app' ;;
    "Copy request for IT") printf 'a message for your IT team, on your clipboard' ;;
  esac
}

# r_box: R_BOX = the pause's box lines (red, amber for a stall), its text
# wrapped and its evidence dimmed.
r_box() {
  local w=$((R_COLS - 6)) c=$C_R k top
  [ "$w" -le 76 ] || w=76
  [ "$w" -ge 30 ] || w=30
  [ "$R_P_KIND" != "stall" ] || c=$C_Y
  R_BOX=()
  top="╭─ $R_P_TITLE "
  while [ "${#top}" -lt $((w - 1)) ]; do top="${top}─"; done
  R_BOX[${#R_BOX[@]}]="  ${c}${top}╮${C_0}"
  r_wrap "$R_P_TEXT" $((w - 4))
  for k in ${WR[@]+"${WR[@]}"}; do r_pad "$k" $((w - 4)); R_BOX[${#R_BOX[@]}]="  ${c}│${C_0} $PD ${c}│${C_0}"; done
  r_pad "" $((w - 4)); R_BOX[${#R_BOX[@]}]="  ${c}│${C_0} $PD ${c}│${C_0}"
  for k in ${R_P_EV[@]+"${R_P_EV[@]}"}; do
    r_pad "$(r_cut "$k" $((w - 4)))" $((w - 4)); R_BOX[${#R_BOX[@]}]="  ${c}│${C_0} ${C_D}$PD${C_0} ${c}│${C_0}"
  done
  top=""; while [ "${#top}" -lt $((w - 2)) ]; do top="${top}─"; done
  R_BOX[${#R_BOX[@]}]="  ${c}╰${top}╯${C_0}"
}

r_on_resolved() {
  R_P_OPEN=0
  R_FORCE=1
  # A notice before the step's next event records what this Skip left out.
  [ "$1" != "skip" ] || R_SKIPPING=1
  if [ "$MODE" = "plain" ]; then
    [ "$1" != "progress" ] || r_plain "moving again"
    return 0
  fi
  if [ "$R_PAUSED" = "1" ]; then
    R_PAUSED=0
    if [ "$1" != "quit" ] && [ "${R_PH:-0}" -gt 0 ] && ! [ -e "$RUN_DIR/pause-printed" ]; then
      # Nothing but the frame, box and menu since the pause: erase them, so
      # the block is redrawn where it was — one header, no stale box.
      printf '\033[%sA\r\033[J' "$R_PH"
    else
      printf '\n'
    fi
    R_H=0; R_PH=0
  fi
}

r_on_fixing() {
  [ "$MODE" = "interactive" ] || { r_plain "Fix with Claude: Claude opened with what went wrong"; return 0; }
  printf '\n  %s●%s %sClaude Code%s %sstarts here with what went wrong and the log. It asks before each command; once it is fixed, the install carries on.%s\n\n' \
    "$C_A" "$C_0" "$C_B" "$C_0" "$C_D" "$C_0"
}

r_on_notice() {
  R_FORCE=1
  # The person's own Skip (it answers a `resolved skip`): nothing to allow or
  # ask again; the done screen names it with what it means.
  if [ "$R_SKIPPING" = "1" ]; then
    r_jstr title "$1"; local title=$JS
    r_jstr text "$1"
    R_LO[${#R_LO[@]}]="$title."
    R_LOT[${#R_LOT[@]}]="$JS"
    [ "$MODE" != "plain" ] || r_plain "note: $title. $JS"
    return 0
  fi
  r_jstr state "$1"; R_N_STATE=$JS
  r_jstr title "$1"; R_N_TITLE=$JS
  r_jstr text "$1"; R_N_TEXT=$JS
  r_jstr without "$1"; R_N_WITHOUT=$JS
  r_jstr id "$1"; R_N_ID=$JS
  R_FORCE=1
  if [ "$MODE" = "plain" ] && [ "$R_N_STATE" = "skipped" ]; then
    r_plain "note: $R_N_TITLE. $R_N_TEXT"
  fi
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

# unit_words <unit>: UW = what a count counts, in the user's words — the
# window's page says the same (model.ts UNIT_WORDS): cargo's crates are the
# "components" equin compiles (no internal names).
unit_words() {
  case "$1" in
    crates) UW="components compiled" ;;
    plugins) UW="plugins built" ;;
    packages) UW="packages installed" ;;
    *) UW=$1 ;;
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
  [ "$4" = "%" ] || { unit_words "$4"; text="$text ($2 of $3 $UW)"; }
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
    # Already closed (a followed build ends the wait it ends, and the waiter
    # ends it again): nothing to say twice.
    [ -n "${S_WON[i]}" ] || return 0
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
    local k
    for ((i = 0; i < ${#R_LO[@]}; i++)); do
      r_ln "  ${C_Y}!${C_0} $(r_cut "${R_LO[i]}" $((R_COLS - 6)))"
      r_wrap "${R_LOT[i]}" $((R_COLS - 6)); for k in ${WR[@]+"${WR[@]}"}; do r_ln "    $k"; done
    done
    [ "${#R_LO[@]}" = 0 ] || r_ln ""
    if [ "$R_N_STATE" = "skipped" ]; then
      r_ln "  ${C_Y}!${C_0} Installed without $R_N_WITHOUT. To add them once Terminal is allowed in"
      r_ln "    Privacy & Security, App Management: ${C_B}./equin start --only $R_N_ID${C_0}"
      r_ln ""
    fi
    if [ "$DRY_RUN" = "1" ]; then r_ln "${C_D}  Dry run: nothing on this machine was changed.${C_0}"
    elif [ "$EDIT_RC" = "1" ]; then
      # Bun and Go are found only inside the install folder (its mise.toml;
      # mise has no global config), so a new terminal must go there first.
      r_ln "${C_D}  To use ./equin: open a new terminal, then ${C_0}cd $R_DIR"
    fi
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
    if [ "$R_P_OPEN" = "1" ] && [ "$R_P_BLOCK" = "0" ]; then # a stall: the install keeps going
      r_box
      for k in "${R_BOX[@]}"; do r_ln "$k"; done
      r_ln "${C_D}  Fix with Claude: run ${R_AGAIN} --fix in another terminal.${C_0}"
      r_ln ""
    fi
    if [ "$R_N_STATE" = "skipped" ]; then
      r_ln "  ${C_Y}!${C_0} $(r_cut "$R_N_TITLE: $R_N_TEXT" $((R_COLS - 6)))"
      r_ln ""
    fi
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
      # A count that reached its total no longer says what the step is doing
      # (it runs on past what was counted): not shown, as in the window.
      if [ -n "${S_PD[i]}" ] && ! { [ -n "${S_PT[i]}" ] && [ "${S_PD[i]}" -ge "${S_PT[i]}" ]; }; then
        if [ "${S_PU[i]}" = "%" ]; then cnt="${S_PD[i]}%"
        else
          unit_words "${S_PU[i]}"
          if [ -n "${S_PT[i]}" ]; then cnt="${S_PD[i]} of ${S_PT[i]} $UW"
          else cnt="${S_PD[i]} $UW"; fi
        fi
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
    # The title back to the terminal's own.
    printf '\033[?25h\033]0;\007\033[23;0t'
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
  if [ "$1" = "start" ] && [ -n "${EQUIN_INSTALL_DRY_RUN_NOTICE:-}" ]; then
    dry_notice skipped
  fi
  local fail=${EQUIN_INSTALL_DRY_RUN_FAIL:-}
  # <step>:part — an optional part of the step fails on every attempt until
  # it is left out, with the step's own diagnosis, as `./equin start` writes
  # it (installer/cli reportInstallDiagnosis).
  if [ "$fail" = "$1:part" ]; then
    case ",${EQUIN_INSTALL_LEFT_OUT:-}," in
      *,dev.equin.menu-bar,*) ;;
      *)
        printf 'title\t%s\ntext\t%s\nleave-out\t%s\nwithout\t%s\nlater\t%s\nevidence\t%s\n' \
          "equin couldn't add the equin icon in your menu bar" \
          "It was adding the equin icon in your menu bar. It needs the GTK and WebKitGTK libraries, which aren't installed on this computer. It's optional: Skip starts equin without it." \
          "dev.equin.menu-bar" \
          "the equin icon in your menu bar" \
          "equin works without it, in your browser. To add it later, run \`./equin start\` again in equin's folder." \
          "dev.equin.menu-bar (menu-bar-helper): missing libgtk-3-dev (dry run)" >"$EQUIN_INSTALL_DIAGNOSIS"
        echo "$1: an optional part failed (dry run)" >&2
        false ;;
    esac
  fi
  if [ "$1" = "${fail%%:*}" ] && [ "$STEP_ATTEMPT" = "1" ]; then
    case "$fail" in
      *:part) ;; # above
      *:sigkill) # killed outright, as a protected shell kills a compiler
        echo "$1: error: could not compile \`ring\` (build script)"
        exec sh -c 'kill -9 $$' ;; # bash 3.2 has no BASHPID: the step's own process dies
      *:vanish) # one of equin's programs removed right after it was made
        mkdir -p "$RUN_DIR/bin"
        printf '#!/bin/sh\n' >"$RUN_DIR/bin/gateway"
        chmod +x "$RUN_DIR/bin/gateway"
        rm -f "$RUN_DIR/bin/gateway"
        "$RUN_DIR/bin/gateway" ;;
      *:quiet) # stuck: no output, no progress, past the watchdog's deadline
        sleep $((${EQUIN_INSTALL_STALL_S:-600} * 2 + 1)) ;;
      *)
        echo "$1: failed (dry run, first attempt)" >&2
        false ;; # mid-body: only `set -e` ends the step here (see run_step)
    esac
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
  sandbox_check
  ev_step tools skipped
  dry_steps mise clone
  # The rest from the checkout's script, attached, as a real install does:
  # the script beside this one (a dry run plays from a checkout).
  local here=""
  [ -z "${BASH_SOURCE[0]:-}" ] || here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -n "$here" ] && [ -x "$here/equin" ] || fail "The dry run plays from a checkout, which runs its steps after the download." "no ./equin beside install.sh"
  hand_to_checkout "$here/install.sh" --dry-run
  fail "The dry run's own steps could not take over after the download." "$here/install.sh carries no attach marker"
}

# dry_checkout_steps: the dry run's attached half (checkout_steps' stand-in).
dry_checkout_steps() {
  dry_steps toolchain start build
  # Nothing started here, so the address is the one this account's equin has
  # (or, never started, would get first): asked of the checkout the dry run
  # is played from, never spelled in this script.
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -x "$here/equin" ] || fail "The dry run plays from a checkout, which names the address." "no ./equin beside install.sh"
  APP_URL="$(cd "$here" && ./equin url)"
  ev_done
  done_wait
}

# dry_steps <id…>: each step played by dry_step.
dry_steps() {
  local id
  for id in "$@"; do
    [ "$id" != "${EQUIN_INSTALL_DRY_RUN_OPTIONAL:-}" ] || STEP_OPTIONAL=1
    run_step "$id" dry_step "$id"
    [ "$STEP_RC" = "0" ] || fail "The $id step of the dry run failed." "dry run, $id"
  done
}

# dry_notice <state>: the notice `./equin start` writes when macOS refused to
# add the login services (its words), through the FIFO by path as start does.
dry_notice() {
  local text
  case "$1" in
    settings-opened) text="Turn on Terminal in Privacy & Security, App Management, then click Add them." ;;
    *) text="With them, equin's apps open in their own windows and get a menu-bar icon. To allow it, turn on Terminal in Privacy & Security, App Management. It's optional: skip it and use equin in your browser." ;;
  esac
  printf '{"v":1,"t":"%s","type":"notice","id":"dev.equin.menu-bar","state":"%s","title":"macOS blocked equin from adding its apps","text":"%s","without":"the menu-bar icon and app shortcuts"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$text" >"$FIFO"
}

# say <message>: one of the script's own progress lines. On the terminal
# view's watch it is a log line of the view (step null): printed straight to
# the terminal it would be drawn over.
say() {
  if [ -n "$RUN_DIR" ] && [ "$MODE" != "window" ] && [ -z "${EQUIN_INSTALL_STEP:-}" ]; then
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
  # The pause before it already said what happened and what to do.
  [ "$PAUSE_QUIT" != "1" ] || exit 1
  if [ -n "$RUN_DIR" ] && [ "$MODE" != "window" ]; then
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
