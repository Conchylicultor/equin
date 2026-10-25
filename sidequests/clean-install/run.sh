#!/usr/bin/env bash
# Runs a steps file (default steps.sh) inside a throwaway macOS VM, from a clean clone of the
# cirruslabs macos-tahoe-vanilla image, and records exactly what happened.
# See CLAUDE.md in this directory for what this is and what it does not cover.
#
# Usage:
#   ./run.sh [--steps <file>] [--name <vm>] [--out <dir>] [--gui] [--keep] [--cpu N] [--memory MB] [--disk-size GB] [--from <step-number>]
#
# --steps     The steps file to run, relative to this directory or absolute.
#             Default steps.sh (run 1's baseline, against docs/setup.md);
#             steps-install.sh is the one-command installer's run.
# --name      VM name. Must start with "si-clean" (safety check below).
#             Default: si-clean-<YYYYmmdd-HHMMSS>
# --out       Where logs/summary go. Must NOT be under ~/.singularity.
#             Default: ~/.equin-clean-install/<name>
# --gui       Open the VM in a window instead of --no-graphics (needed once,
#             for the interactive Claude Code login — see CLAUDE.md).
# --keep      Don't stop/delete the VM on success. Combine with --from to
#             resume a run against the same VM.
# --cpu       VM core count. Default 6.
# --memory    VM memory in MB. Default 12288.
# --disk-size VM disk size in GB, set right after cloning, before first
#             boot (a disk can't be grown after that). Default 90 — the
#             base image ships with ~17GB free, too tight for
#             brew+go+bun+postgres+node_modules+Chromium+the embedded PG
#             cluster.
# --from N    Skip steps 1..N-1 and start at step N (resuming a --keep VM).
# --upload L:G  Copy the host file L to G in the guest (scp) before the first
#             step. Repeatable. For handing the guest something a new user
#             would fetch from the network once it is published.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TART="${TART_BIN:-$HOME/.local/bin/tart}"

# ---- argument parsing -------------------------------------------------

VM_NAME=""
OUT_DIR=""
GUI=0
KEEP=0
CPU=6
MEMORY=12288
DISK_SIZE=90
FROM=1
STEPS_FILE="steps.sh"
UPLOADS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) VM_NAME="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --gui) GUI=1; shift ;;
    --keep) KEEP=1; shift ;;
    --cpu) CPU="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --disk-size) DISK_SIZE="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --steps) STEPS_FILE="$2"; shift 2 ;;
    --upload) UPLOADS+=("$2"); shift 2 ;;
    -h|--help)
      sed -n '2,31p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

case "$STEPS_FILE" in
  /*) ;;
  *) STEPS_FILE="$SCRIPT_DIR/$STEPS_FILE" ;;
esac
if [[ ! -f "$STEPS_FILE" ]]; then
  echo "No such steps file: $STEPS_FILE" >&2
  exit 1
fi

if [[ -z "$VM_NAME" ]]; then
  VM_NAME="si-clean-$(date +%Y%m%d-%H%M%S)"
fi
if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$HOME/.equin-clean-install/$VM_NAME"
fi

# ---- safety assertions -------------------------------------------------
# This harness must never touch the author's real ~/.singularity (gateway on
# 9000, embedded Postgres, secrets) or the machine's own VM fleet outside
# this convention. See "Why the running main instance is untouched" in
# CLAUDE.md.

case "$VM_NAME" in
  si-clean*) ;;
  *)
    echo "Refusing: VM name '$VM_NAME' must start with 'si-clean' (safety convention so cleanup/prune never touches an unrelated VM)." >&2
    exit 1
    ;;
esac

SINGULARITY_DIR_RESOLVED="$(cd "$HOME" && printf '%s/.singularity/' "$PWD")"
OUT_DIR_PARENT="$(dirname "$OUT_DIR")"
mkdir -p "$OUT_DIR_PARENT"
OUT_DIR_RESOLVED="$(cd "$OUT_DIR_PARENT" && printf '%s/%s/' "$PWD" "$(basename "$OUT_DIR")")"
case "$OUT_DIR_RESOLVED" in
  "$SINGULARITY_DIR_RESOLVED"*)
    echo "Refusing: --out '$OUT_DIR' resolves inside ~/.singularity. This harness must never write there — pick a different --out." >&2
    exit 1
    ;;
esac

mkdir -p "$OUT_DIR"

echo "VM name : $VM_NAME"
echo "Out dir : $OUT_DIR"
echo "Steps   : $STEPS_FILE"
echo "CPU/RAM : $CPU cores / ${MEMORY}MB"
echo "Disk    : ${DISK_SIZE}GB"
echo

# ---- helpers -------------------------------------------------------------

log() { printf '%s\n' "$*"; }
banner() { printf '\n=== %s ===\n' "$*"; }

VM_IP=""
SSH_KEY="$OUT_DIR/id_ed25519"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

# Reads a shell script from stdin and runs it inside the guest as "admin",
# in a login shell, over ssh with this run's own throwaway key (installed
# by ensure_ssh_access below). Reading the script from stdin — rather than
# building a shell command line out of the step's text — means the step's
# own quoting never has to survive a second round of shell parsing.
guest_run() {
  ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "admin@$VM_IP" 'bash -l -s'
}

vm_exists() {
  "$TART" list --quiet 2>/dev/null | grep -qxF "$VM_NAME"
}

vm_is_running() {
  "$TART" list 2>/dev/null | grep -F "$VM_NAME" | grep -qi running
}

# The vanilla base image has no Tart Guest Agent, so `tart exec` is not an
# option here (confirmed: it fails with "is the Tart Guest Agent running?").
# ssh is the only transport. Its first boot takes a couple of minutes, and
# until the guest's DHCP/routing settles, connection attempts fail with
# "No route to host" rather than a clean refusal — that's expected, not a
# reason to give up. Poll with a short per-attempt timeout until sshd is
# actually answering: with no key installed yet, a reachable sshd rejects a
# BatchMode (no-password-prompt) attempt with "Permission denied", which is
# the signal we're waiting for.
wait_for_sshd() {
  local deadline=$((SECONDS + 480))
  local out=""
  while (( SECONDS < deadline )); do
    out="$(ssh -o BatchMode=yes -o ConnectTimeout=4 "${SSH_OPTS[@]}" "admin@$VM_IP" true 2>&1)" || true
    if [[ "$out" == *"Permission denied"* ]]; then
      return 0
    fi
    sleep 3
  done
  echo "ERROR: guest sshd never answered within 480s. Last attempt said: $out" >&2
  return 1
}

keyed_ssh_ok() {
  ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=6 "${SSH_OPTS[@]}" "admin@$VM_IP" true >/dev/null 2>&1
}

# Types the guest's default password ("admin") exactly once, via expect
# (ships with macOS at /usr/bin/expect — nothing extra to install), to
# append this run's own throwaway public key to the guest's
# authorized_keys. Every other guest command afterwards uses that key.
install_pubkey() {
  local pubkey expect_script
  pubkey="$(cat "${SSH_KEY}.pub")"
  expect_script="$OUT_DIR/install_key.expect"
  cat > "$expect_script" <<'EXPECT_EOF'
#!/usr/bin/expect -f
set timeout 30
set ip [lindex $argv 0]
set pubkey [lindex $argv 1]
log_user 1
spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR admin@$ip "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$pubkey' >> ~/.ssh/authorized_keys && sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
expect {
  -re "assword:" { send "admin\r" }
  timeout { puts "ERROR: no password prompt from guest sshd"; exit 1 }
}
expect eof
EXPECT_EOF
  chmod +x "$expect_script"
  log "Installing this run's ssh key into the guest (one password prompt, typed by expect)…"
  expect "$expect_script" "$VM_IP" "$pubkey"
}

ensure_ssh_access() {
  if [[ ! -f "$SSH_KEY" ]]; then
    ssh-keygen -q -t ed25519 -N '' -f "$SSH_KEY"
  fi
  if keyed_ssh_ok; then
    log "Key already authorized (resumed run) — skipping password step."
    return
  fi
  install_pubkey || true
  if ! keyed_ssh_ok; then
    fail_and_leave_running "ERROR: key-based ssh still doesn't work after installing the public key."
  fi
}

# Reboots the guest and waits until this run's key works again. A real
# reboot, not a tart stop/start: what comes back afterwards is exactly what a
# user's machine would bring back by itself (e.g. the gateway's launchd
# LaunchAgent, which loads when the auto-logged-in `admin` session starts).
reboot_guest() {
  printf 'sudo shutdown -r now\n' | guest_run || true
  local deadline=$((SECONDS + 120))
  while keyed_ssh_ok && (( SECONDS < deadline )); do sleep 2; done
  VM_IP="$("$TART" ip "$VM_NAME" --wait 240)"
  deadline=$((SECONDS + 480))
  until keyed_ssh_ok; do
    if (( SECONDS >= deadline )); then
      echo "guest did not answer ssh within 480s of rebooting" >&2
      return 1
    fi
    sleep 3
  done
}

fail_and_leave_running() {
  local msg="$1"
  echo "$msg" >&2
  echo >&2
  echo "VM left running for inspection: $VM_NAME" >&2
  echo "Out dir: $OUT_DIR" >&2
  if [[ -f "$SSH_KEY" ]] && [[ -n "$VM_IP" ]]; then
    echo "Shell in:  ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null admin@$VM_IP" >&2
  elif [[ -n "$VM_IP" ]]; then
    echo "Shell in:  ssh admin@$VM_IP   # password: admin" >&2
  else
    echo "Shell in:  $TART ip $VM_NAME   # then ssh admin@<ip>, password admin" >&2
  fi
  exit 1
}

# ---- 1. clone the base image if this VM doesn't exist yet ---------------

banner "1/5 clone"
if vm_exists; then
  log "VM '$VM_NAME' already exists — reusing (expected when resuming with --from)."
else
  "$TART" clone ghcr.io/cirruslabs/macos-tahoe-vanilla:latest "$VM_NAME"
  # Grow the disk now, before first boot — a disk can't be grown once the
  # guest has partitioned it. The base image's ~17GB free is too tight for
  # brew + go + bun + postgres + node_modules + Chromium + the embedded PG
  # cluster.
  "$TART" set "$VM_NAME" --disk-size "$DISK_SIZE"
fi

# ---- 2. size it -----------------------------------------------------------

banner "2/5 configure cpu/memory"
"$TART" set "$VM_NAME" --cpu "$CPU" --memory "$MEMORY"

# ---- 3. start it, detached ------------------------------------------------

banner "3/5 start"
if vm_is_running; then
  log "VM '$VM_NAME' is already running — reusing (expected when resuming with --from)."
else
  RUN_ARGS=("$VM_NAME")
  [[ "$GUI" -eq 0 ]] && RUN_ARGS+=(--no-graphics)
  nohup "$TART" run "${RUN_ARGS[@]}" >"$OUT_DIR/vm.log" 2>&1 &
  VM_PID=$!
  disown "$VM_PID"
  log "Started (pid $VM_PID), output -> $OUT_DIR/vm.log"
fi

# ---- 4. wait for an IP -----------------------------------------------------

banner "4/5 wait for IP"
VM_IP="$("$TART" ip "$VM_NAME" --wait 120)"
log "IP: $VM_IP"

# ---- 5. wait for sshd, then get this run's own key onto the guest --------

banner "5/5 wait for sshd, install ssh key"
if ! wait_for_sshd; then
  fail_and_leave_running "ERROR: guest sshd did not come up."
fi
ensure_ssh_access

for up in ${UPLOADS[@]+"${UPLOADS[@]}"}; do
  log "Uploading ${up%%:*} -> guest:${up#*:}"
  scp -q -i "$SSH_KEY" "${SSH_OPTS[@]}" "${up%%:*}" "admin@$VM_IP:${up#*:}" \
    || fail_and_leave_running "ERROR: upload of ${up%%:*} failed."
done

# ---- run the steps file's steps ----------------------------------------------

# shellcheck source=./steps.sh
source "$STEPS_FILE"

SUMMARY="$OUT_DIR/summary.tsv"
if [[ "$FROM" -le 1 || ! -f "$SUMMARY" ]]; then
  printf 'index\tslug\ttag\texit_code\tduration_seconds\tdoc\n' > "$SUMMARY"
fi

RUN_START=$SECONDS
STEP_INDEX=0
for fn in "${STEPS[@]}"; do
  STEP_INDEX=$((STEP_INDEX + 1))
  if [[ "$STEP_INDEX" -lt "$FROM" ]]; then
    continue
  fi

  # step_NN_slug -> NN, slug
  if [[ "$fn" =~ ^step_([0-9]+)_(.+)$ ]]; then
    NN="${BASH_REMATCH[1]}"
    SLUG="${BASH_REMATCH[2]}"
  else
    echo "Malformed step function name: $fn" >&2
    exit 1
  fi
  DOC_VAR="${fn}_DOC"
  TAG_VAR="${fn}_TAG"
  DOC="${!DOC_VAR:-}"
  TAG="${!TAG_VAR:-}"
  LOG_FILE="$OUT_DIR/${NN}-${SLUG}.log"

  banner "step $NN/$fn ($TAG)"
  echo "docs/setup.md says: $DOC"
  CMD_TEXT="$("$fn")"
  echo "--- command sent to guest ---"
  printf '%s\n' "$CMD_TEXT"
  echo "------------------------------"

  START=$SECONDS
  set +e
  REBOOT_VAR="${fn}_REBOOT"
  if [[ "${!REBOOT_VAR:-0}" == "1" ]]; then
    # A <fn>_REBOOT=1 step reboots the guest (its own command text is only
    # what gets logged); its duration is the time until ssh answers again.
    reboot_guest >"$LOG_FILE" 2>&1
  else
    printf '%s\n' "$CMD_TEXT" | guest_run >"$LOG_FILE" 2>&1
  fi
  EXIT_CODE=$?
  set -e
  DURATION=$((SECONDS - START))

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$NN" "$SLUG" "$TAG" "$EXIT_CODE" "$DURATION" "$DOC" >> "$SUMMARY"

  if [[ "$EXIT_CODE" -ne 0 ]]; then
    echo "FAILED (exit $EXIT_CODE, ${DURATION}s). Last 30 lines of $LOG_FILE:" >&2
    tail -n 30 "$LOG_FILE" >&2
    # A step marked <fn>_EXPECT_FAIL=1 is a blocker a previous run already
    # recorded, whose fix is the step right after it. Its failure is the
    # finding, so the run records it and carries on. Anything else is new:
    # stop, so the guest can be inspected while it is still in that state.
    EXPECT_VAR="${fn}_EXPECT_FAIL"
    if [[ "${!EXPECT_VAR:-0}" == "1" ]]; then
      log "expected failure (already a recorded finding) — continuing"
    else
      fail_and_leave_running "Stopping at step $NN ($SLUG). Resume after investigating with: $0 --name $VM_NAME --keep --from $NN"
    fi
  else
    log "ok (${DURATION}s)"
  fi
done

TOTAL_DURATION=$((SECONDS - RUN_START))

# ---- success: print the summary, then clean up unless --keep -------------

banner "summary"
column -t -s $'\t' "$SUMMARY" || cat "$SUMMARY"
echo
echo "Total wall time for the steps run: ${TOTAL_DURATION}s"

if [[ "$KEEP" -eq 0 ]]; then
  banner "cleanup"
  "$TART" stop "$VM_NAME" || true
  "$TART" delete "$VM_NAME"
  log "Deleted $VM_NAME"
else
  log "Kept VM '$VM_NAME' running (--keep). Delete it yourself with: $TART stop $VM_NAME && $TART delete $VM_NAME"
fi
