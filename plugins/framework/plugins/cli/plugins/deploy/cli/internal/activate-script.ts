/**
 * The activate script: what runs on the host once a bundle has landed.
 *
 * Beside `converge-script.ts` for the same reason that one exists — a shell
 * template whose only execution path is a remote host is a template whose typos
 * are discovered in production — and it shares that file's `sq`, so the two
 * scripts quote their interpolations exactly one way.
 */
import {
  REMOTE_SCRIPT_SHEBANG,
  listenAddress,
  releaseAppPath,
  releaseDir,
  type InstallLayout,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { deploySecretsVisibilityEndpoint } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/core";
import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import type { HealthResponse } from "@plugins/infra/plugins/health/core";
import { sq } from "./converge-script";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  READY_ATTEMPTS,
  READY_INTERVAL_SEC,
  SETTLE_DEADLINE_SEC,
  SETTLE_INTERVAL_SEC,
  SETTLE_SILENCE_SEC,
} from "./target";

// The `/api/health` fields and value the gate greps for, typed against the
// response schema: a rename there is a tsc error here, not a gate that greps
// for a field nobody sends and fails (or "unproven"s) every ship.
const STARTED_AT_FIELD = "startedAt" satisfies keyof HealthResponse;
const BOOT_FIELD = "boot" satisfies keyof HealthResponse;
const RUN_ID_FIELD = "runId" satisfies keyof HealthResponse;
const SETTLED = "settled" satisfies NonNullable<HealthResponse["boot"]>;

/**
 * `health_started_at BODY` — the `startedAt` an `/api/health` answer names,
 * or nothing. The one reader of it, for the ready answer and every settle poll.
 */
const HEALTH_STARTED_AT_SH = `health_started_at() {
  printf '%s' "$1" | grep -Eo '"${STARTED_AT_FIELD}"[[:space:]]*:[[:space:]]*[0-9]+' | grep -Eo '[0-9]+$' || true
}`;

/**
 * `settle_gate HEALTH_URL STARTED_AT` — the shipped process must report its
 * boot settled before the release counts as live.
 *
 * The same definition as a local `./equin build`
 * (`plugins/framework/plugins/cli/plugins/build/cli/internal/stay-up.ts`): a
 * backend is deployed when the process that took over — its `startedAt` is its
 * identity — reports `boot: "settled"`, i.e. every boot phase ran in it, the
 * post-ready ones and `onSettled` included. One ready answer is not enough:
 * readiness is the barrier BEFORE those phases, so a release that crashes in
 * `onReady` answers once and is then respawned (and crashes again) — on
 * 2026-11-08 a local crash loop of exactly that shape passed five builds.
 *
 * Settling is an event the backend reports; the deadline only decides what to
 * say when it has not come. Statuses (the reason in `$SETTLE_DETAIL`):
 *
 *   0  settled — the process that took over reports it
 *   1  died — another process (another `startedAt`) answers in its place
 *   2  unproven — the deadline passed while the SAME process still answers,
 *      unsettled (`onSettled` still running, or a bundle from before the
 *      `boot` field): alive and serving, so the caller passes with a warning
 *      rather than reverting production over a slow warm-up
 *   3  silent — the deadline passed and the process has not answered for
 *      `SETTLE_SILENCE_SEC`: not serving. A window, not the last poll alone,
 *      so one timed-out poll on a busy host does not revert a live release
 *
 * The rule is mirrored from `stay-up.ts` rather than generated from it: the
 * gate must run ON the host (the revert has to survive the CLI dying or the
 * connection dropping mid-gate), so its loop is bash, and its deadline arms
 * legitimately differ — the local build asks the gateway whether a silent
 * backend is gone, a release host has no such oracle, so silence fails here.
 * What both read off the wire is shared: the field names and the `settled`
 * value are typed against `HealthResponse` above.
 *
 * A function, not inline gate text, so the test can run it against a stubbed
 * `curl` and assert the whole table. Every pipeline that may legitimately
 * match nothing ends in `|| true`: under `set -euo pipefail` a grep miss
 * inside `$(…)` would otherwise exit the script mid-gate.
 */
export const SETTLE_GATE_SH = `${HEALTH_STARTED_AT_SH}
settle_gate() {
  local url="$1" incarnation="$2"
  local deadline=$(( SECONDS + \${SETTLE_DEADLINE_SEC:-${SETTLE_DEADLINE_SEC}} ))
  local answer="" seen boot last_boot=""
  # The ready answer that named the runId came from this process just now.
  local answered_at=$SECONDS
  SETTLE_DETAIL=""
  while :; do
    answer="$(curl -fsS -m 5 "$url" 2>/dev/null || true)"
    seen="$(health_started_at "$answer")"
    boot="$(printf '%s' "$answer" | grep -Eo '"${BOOT_FIELD}"[[:space:]]*:[[:space:]]*"[a-z]+"' | grep -Eo '[a-z]+"$' | tr -d '"' || true)"
    if [ -n "$seen" ] && [ "$seen" != "$incarnation" ]; then
      SETTLE_DETAIL="a new process (startedAt $seen) answers in its place"
      return 1
    fi
    if [ -n "$seen" ]; then
      if [ "$boot" = "${SETTLED}" ]; then return 0; fi
      answered_at=$SECONDS
      last_boot="$boot"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then break; fi
    sleep \${SETTLE_INTERVAL_SEC:-${SETTLE_INTERVAL_SEC}}
  done
  local quiet=$(( SECONDS - answered_at ))
  if [ "$quiet" -le "\${SETTLE_SILENCE_SEC:-${SETTLE_SILENCE_SEC}}" ]; then
    SETTLE_DETAIL="it still answers (boot: \${last_boot:-not reported}) but its boot has not settled"
    return 2
  fi
  SETTLE_DETAIL="it has not answered $url for \${quiet}s"
  return 3
}`;

// ── D4: bundle discovery + the activate script ────────────────────────────────
//
// Bundle discovery itself lives in `@plugins/release/plugins/bundles` — the one
// authority on "which bundle would ship, and why not", shared with the (future)
// HTTP surface that has to answer the same question without exiting a process.
// Ship's only job here is to turn its refusal into this command's exit.

/**
 * Activate an uploaded bundle: extract it while the previous release serves,
 * then either SWAP the backend through the running gateway (no restart — the
 * new backend is up and ready before the old one stops) or, when the release
 * changes the host itself (gateway, Postgres, PgBouncer, how they start),
 * RESTART the host unit. Either way the same health gate follows, and a
 * failure reverts to the previous release.
 *
 * This is ONE script on the host rather than a sequence of `sshRun`s for one
 * reason: the revert must run even if the CLI dies or the connection drops
 * mid-gate. A deploy command whose failure mode is "the site is now broken and
 * stays broken" is not shippable.
 *
 * Design: research/2026-11-14-global-zero-wait-site-deploys.md.
 */
export function activateScript(opts: {
  install: InstallLayout;
  runId: string;
  binaryName: string;
  loopbackPort: number;
}): string {
  const { install, runId, binaryName, loopbackPort } = opts;
  const dir = releaseDir(install.compositionId, runId);
  const base = `http://${listenAddress(loopbackPort)}`;

  return `${REMOTE_SCRIPT_SHEBANG}
# GENERATED by \`./equin deploy ship\` — do NOT edit on the host.
set -euo pipefail

# Progress to stderr, for the same reason as the converge script: a FAILED
# \`sshRun\` returns stderr only, and the failing ship is the one whose log
# matters. See \`runScript\` in \`./target.ts\`.
exec 1>&2

UNIT=${sq(install.unit)}
RUN_USER=${sq(install.runUser)}
RELEASE_DIR=${sq(dir)}
BINARY=${sq(binaryName)}
APP=${sq(releaseAppPath(install.compositionId, runId))}
CURRENT=${sq(install.currentLink)}
RUNTIME=${sq(install.runtimeDir)}
CACHE=${sq(`${install.runtimeDir}/equin-release`)}
DATA=${sq(install.dataDir)}
ENV_FILE=${sq(install.envFile)}
READY_URL=${sq(`${base}/api/health/ready`)}
HEALTH_URL=${sq(`${base}/api/health`)}
SECRETS_URL=${sq(`${base}${endpointPath(deploySecretsVisibilityEndpoint, {})}`)}
CRED_DIR=${sq(install.credentialsDir)}
RUN_ID=${sq(runId)}
# The file naming the dir a release's bundle is extracted to — written beside
# each release by its own ship, read by a later ship's revert.
EXTRACTED_AT=extract-dir

if [ ! -s "$RELEASE_DIR/$BINARY" ]; then
  echo "activate: $RELEASE_DIR/$BINARY is missing or empty — the upload did not land" >&2
  exit 1
fi
chmod 755 "$RELEASE_DIR/$BINARY"

# The fixed-name entrypoint, created BEFORE anything can point \`current\` at
# this dir, so \`current\` never names a dir the unit cannot exec. Relative, so
# the release dir stays relocatable.
ln -sfn "$BINARY" "$APP.new"
mv -fT "$APP.new" "$APP"
chown -R "$RUN_USER:$RUN_USER" "$RELEASE_DIR"

# What was serving — what a failure restores. Empty on a first ship.
PREV="$(readlink "$CURRENT" 2>/dev/null || true)"

# Run a command as the run user, in the unit's environment (the converge env
# file, the data root, the extraction cache root) — what the unit's own
# processes see.
as_app() {
  (
    set -a
    . "$ENV_FILE"
    set +a
    exec runuser -u "$RUN_USER" -- env ${envName("DIR")}="$DATA" ${envName("RELEASE_DIR")}="$RUNTIME" "$@"
  )
}

# ── 1. Extract while the previous release still serves. ──────────────────────
# The extractor renames a complete extraction into place, so a dir that exists
# is whole. It prints the dir as its last line.
echo "[~] extracting the bundle"
EXTRACT="$(as_app ${envName("RELEASE_EXTRACT_ONLY")}=1 "$APP" | tail -n 1)"
if [ ! -x "$EXTRACT/launch" ]; then
  echo "activate: the bundle did not extract (no launch under '$EXTRACT')" >&2
  exit 1
fi
printf '%s\\n' "$EXTRACT" > "$RELEASE_DIR/$EXTRACTED_AT"
echo "[+] extracted to $EXTRACT"

journal_tail() {
  echo "--- journalctl -u $UNIT -n 200 ---" >&2
  journalctl -u "$UNIT" -n 200 --no-pager >&2 || true
  local gw="$DATA/logs/gateway/gateway.log"
  if [ -f "$gw" ]; then
    echo "--- tail -n 60 $gw ---" >&2
    tail -n 60 "$gw" >&2 || true
  fi
}

# ── 2. Swap, or restart the host. ────────────────────────────────────────────
# \`launch swap\` exits 0 once the gateway serves this release's backend (the
# old one keeps serving until then, and a backend that never gets ready leaves
# it serving and the gateway's spec unchanged), 3 when this release changes the
# host itself, anything else when the swap failed with nothing changed.
MODE=""
FLIPPED=0
SWAPPED=0
GATE_OK=0
swap_status=0
as_app "$EXTRACT/launch" swap || swap_status=$?
case "$swap_status" in
  0)
    MODE=swap
    SWAPPED=1
    echo "[+] swapped the backend (no restart): the previous one drains while this one serves"
    ;;
  3)
    MODE=restart
    echo "[host restart] this release changes the host (reason above): visitors wait while $UNIT restarts"
    ;;
  *)
    echo "activate: the swap failed; the previous release still serves, unchanged" >&2
    journal_tail
    exit 1
    ;;
esac

# EVERY failure after this point undoes itself, not just a failed gate: a unit
# that will not restart or an ssh deadline mid-gate would otherwise leave the
# site on a build that is not serving. The trap is what makes "production is
# never left down by a bad ship" true for the whole rest of the script.
undo() {
  set +e   # best-effort recovery; the script's own non-zero status still stands
  if [ "$SWAPPED" -eq 1 ]; then
    # Swap the previous release's backend back in — the same zero-wait path.
    # Its extraction is still on disk (pruning runs only after a passed gate).
    prev_extract=""
    if [ -n "$PREV" ] && [ -f "$PREV/$EXTRACTED_AT" ]; then
      prev_extract="$(cat "$PREV/$EXTRACTED_AT")"
    fi
    if [ -n "$prev_extract" ] && [ -x "$prev_extract/launch" ] && as_app "$prev_extract/launch" swap; then
      echo "reverted: swapped the backend back to $PREV" >&2
    elif [ -n "$PREV" ]; then
      # \`current\` still names PREV (a swap flips it only after the gate).
      if systemctl restart "$UNIT"; then
        echo "reverted: could not swap back, restarted $UNIT on $PREV" >&2
      else
        echo "reverted: could not swap back, and restarting $UNIT ALSO failed — the host is DOWN" >&2
      fi
    fi
  fi
  if [ "$FLIPPED" -eq 1 ]; then
    if [ -n "$PREV" ]; then
      ln -sfn "$PREV" "$CURRENT.new"
      mv -fT "$CURRENT.new" "$CURRENT"
      # Say which of the two happened: "reverted and restarted" and "reverted but
      # the host is still down" are very different things to be told.
      if systemctl restart "$UNIT"; then
        echo "reverted: current -> $PREV, $UNIT restarted" >&2
      else
        echo "reverted: current -> $PREV, but restarting $UNIT ALSO failed — the host is DOWN" >&2
      fi
    else
      systemctl stop "$UNIT"
      rm -f "$CURRENT"
      echo "reverted: nothing served before this ship — $UNIT stopped, current removed" >&2
    fi
  fi
  journal_tail
}
on_exit() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$GATE_OK" -eq 0 ]; then undo; fi
  exit "$status"
}
trap on_exit EXIT

flip_current() {
  # rename(2) over the existing symlink, so no window exists in which
  # \`current\` is absent.
  ln -sfn "$RELEASE_DIR" "$CURRENT.new"
  mv -fT "$CURRENT.new" "$CURRENT"
  echo "[+] current -> $RELEASE_DIR (was: \${PREV:-<none>})"
}

if [ "$MODE" = restart ]; then
  # The host restart IS the flip: the unit runs \`current\`. Already extracted,
  # so the gap is the stop and the boot, not the unpacking.
  flip_current
  FLIPPED=1
  systemctl restart "$UNIT"
fi

${SETTLE_GATE_SH}

# ── 3. The health gate. Five outcomes, deliberately distinguished:
#     ok=1  ready, serving the runId we shipped, settled → success
#     ok=0  never became ready within the window     → "not up"
#     ok=2  ready, but /api/health names another build → the switch did not take
#     ok=3  serving, but a deploy secret is unreadable  → see below
#     ok=4  ready, then died (or went silent) before its boot settled
ok=0
body=""
for _ in $(seq 1 ${READY_ATTEMPTS}); do
  if curl -fsS -m 5 "$READY_URL" >/dev/null 2>&1; then ok=1; break; fi
  sleep ${READY_INTERVAL_SEC}
done
if [ "$ok" -eq 1 ]; then
  body="$(curl -fsS -m 5 "$HEALTH_URL" || true)"
  # Liveness alone would let a failed switch pass as success: the PREVIOUS build
  # answers /api/health/ready perfectly happily. The runId is what makes "the
  # build I shipped is the build now answering" checkable.
  printf '%s' "$body" | grep -Eq '"${RUN_ID_FIELD}"[[:space:]]*:[[:space:]]*"'"$RUN_ID"'"' || ok=2
fi

# Ready is the barrier BEFORE the post-ready boot phases: the process that
# answered must also live through them (\`settle_gate\` above). Its startedAt,
# read off the same answer that named the runId, is which process that is.
settle=""
if [ "$ok" -eq 1 ]; then
  STARTED_AT="$(health_started_at "$body")"
  if [ -z "$STARTED_AT" ]; then
    settle="/api/health names no startedAt, so no process can be followed to its settled boot"
    ok=4
  else
    echo "[~] ready (startedAt $STARTED_AT); waiting up to ${SETTLE_DEADLINE_SEC}s for its boot to settle"
    settle_status=0
    settle_gate "$HEALTH_URL" "$STARTED_AT" || settle_status=$?
    case "$settle_status" in
      0) echo "[ok] boot settled" ;;
      2) echo "[warn] staying up is unproven: $SETTLE_DETAIL after ${SETTLE_DEADLINE_SEC}s — passing, it is serving" ;;
      *) settle="$SETTLE_DETAIL"; ok=4 ;;
    esac
  fi
fi

# ok=3  serving, but cannot read a deploy secret converge installed. A secret
#       is approved, encrypted and loaded by systemd, yet only the app reading
#       it proves it arrived — the runtime tree between them (launcher →
#       gateway → backend) has dropped one silently before. Asked of the
#       running app over the host-only route, through the SAME read its
#       consumers use; the answer names keys, never values.
unreadable=""
secrets=""
if [ "$ok" -eq 1 ] && [ -d "$CRED_DIR" ]; then
  if [ ! -x "$CRED_DIR" ]; then
    echo "gate: cannot list $CRED_DIR (ship must run as root)" >&2
    exit 1
  fi
  keys=""
  for _f in "$CRED_DIR"/*.cred; do
    [ -e "$_f" ] || continue
    _k="$(basename "$_f" .cred)"
    keys="\${keys:+$keys,}$_k"
  done
  if [ -n "$keys" ]; then
    secrets="$(curl -fsS -m 5 "$SECRETS_URL?keys=$keys" 2>&1 || true)"
    for _k in \${keys//,/ }; do
      printf '%s' "$secrets" | grep -Eq '"'"$_k"'"[[:space:]]*:[[:space:]]*"set"' || unreadable="$unreadable $_k"
    done
    if [ -n "$unreadable" ]; then ok=3; else echo "[ok] the app reads its deploy secrets: $keys"; fi
  fi
fi

if [ "$ok" -ne 1 ]; then
  if [ "$ok" -eq 0 ]; then
    echo "gate: $UNIT never became ready at $READY_URL within ${
      READY_ATTEMPTS * READY_INTERVAL_SEC
    }s" >&2
  elif [ "$ok" -eq 2 ]; then
    echo "gate: ready, but /api/health does not report the shipped runId $RUN_ID:" >&2
    printf '%s\\n' "$body" >&2
  elif [ "$ok" -eq 4 ]; then
    echo "gate: ready and serving runId $RUN_ID, then lost before its boot settled — $settle. A crash in a post-ready boot phase repeats on every start of this release." >&2
  else
    echo "gate: serving, but the app cannot read deploy secret(s):$unreadable — they are approved and installed in $CRED_DIR, yet do not reach the backend. The app answered:" >&2
    printf '%s\\n' "$secrets" >&2
  fi
  # The trap does the revert and prints the journal — one recovery path for
  # every failure mode, not one per branch that remembered.
  exit 1
fi
GATE_OK=1

# A swapped release becomes \`current\` once it passed: a later restart of the
# unit (a crash, a reboot, a host restart) boots the release that serves.
if [ "$MODE" = swap ]; then flip_current; fi

# ── 4. Prune extractions nothing runs from. ──────────────────────────────────
# Kept: this release's, and every one a process of the unit still executes
# from — the host generation's gateway and Postgres, a previous backend still
# draining. On a box nobody SSHes into, disk-fill is the failure that takes the
# site down silently.
in_use=" $EXTRACT "
cgroup="$(systemctl show -p ControlGroup --value "$UNIT" 2>/dev/null || true)"
if [ -n "$cgroup" ] && [ -r "/sys/fs/cgroup$cgroup/cgroup.procs" ]; then
  while read -r pid; do
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    case "$exe" in
      "$CACHE"/*)
        rest="\${exe#"$CACHE"/}"
        in_use="$in_use $CACHE/\${rest%%/*} "
        ;;
    esac
  done < "/sys/fs/cgroup$cgroup/cgroup.procs"
fi
for d in "$CACHE"/*; do
  [ -d "$d" ] || continue
  case "$in_use" in
    *" $d "*) ;;
    *) rm -rf -- "$d"; echo "[=] pruned the unused extraction $d" ;;
  esac
done

echo "[ok] $UNIT is serving runId $RUN_ID ($MODE)"
printf '%s\\n' "$body"
`;
}
