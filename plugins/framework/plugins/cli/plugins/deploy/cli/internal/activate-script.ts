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
 * Activate an uploaded bundle: entrypoint symlink → flip `current` → restart →
 * health gate, reverting on failure.
 *
 * This is ONE script on the host rather than a sequence of `sshRun`s for one
 * reason: the revert must run even if the CLI dies or the connection drops
 * mid-gate. A deploy command whose failure mode is "the site is now broken and
 * stays broken" is not shippable.
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
CACHE=${sq(`${install.runtimeDir}/equin-release`)}
STALE=${sq(`${install.runtimeDir}/.stale-`)}$$
READY_URL=${sq(`${base}/api/health/ready`)}
HEALTH_URL=${sq(`${base}/api/health`)}
SECRETS_URL=${sq(`${base}${endpointPath(deploySecretsVisibilityEndpoint, {})}`)}
CRED_DIR=${sq(install.credentialsDir)}
RUN_ID=${sq(runId)}

if [ ! -s "$RELEASE_DIR/$BINARY" ]; then
  echo "activate: $RELEASE_DIR/$BINARY is missing or empty — the upload did not land" >&2
  exit 1
fi
chmod 755 "$RELEASE_DIR/$BINARY"

# The fixed-name entrypoint, created BEFORE the flip so \`current\` never points
# at a dir the unit cannot exec. Relative, so the release dir stays relocatable.
ln -sfn "$BINARY" "$APP.new"
mv -fT "$APP.new" "$APP"
chown -R "$RUN_USER:$RUN_USER" "$RELEASE_DIR"

# What was serving, captured before the flip — this is what a failure restores.
# Empty on a first ship, which is a state of its own below.
PREV="$(readlink "$CURRENT" 2>/dev/null || true)"

MOVED=0
FLIPPED=0
GATE_OK=0

# EVERY failure after this point undoes itself, not just a failed gate: a unit
# that will not restart (an un-converged host) or an ssh deadline mid-gate would
# otherwise leave \`current\` pointing at a build that is not serving. The trap is
# what makes "production is never left down by a bad ship" true for the whole
# rest of the script rather than for the one branch that thought of it.
undo() {
  set +e   # best-effort recovery; the script's own non-zero status still stands
  if [ "$MOVED" -eq 1 ]; then
    mkdir -p "$CACHE"
    mv -- "$STALE"/* "$CACHE"/
    rmdir "$STALE"
    echo "reverted: restored the previous extraction cache" >&2
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
  echo "--- journalctl -u $UNIT -n 200 ---" >&2
  journalctl -u "$UNIT" -n 200 --no-pager >&2
}
on_exit() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$GATE_OK" -eq 0 ]; then undo; fi
  exit "$status"
}
trap on_exit EXIT

# Move the extraction cache aside rather than deleting it. The self-extractor
# keys its extract dir on the tarball hash, so every ship would otherwise leave
# a full extracted bundle behind forever — but a revert needs the PREVIOUS
# bundle's cache, so it is only destroyed once the gate has passed.
if [ -d "$CACHE" ] && [ -n "$(ls -A "$CACHE" 2>/dev/null || true)" ]; then
  mkdir -p "$STALE"
  mv -- "$CACHE"/* "$STALE"/
  MOVED=1
fi

# The flip IS the deploy. rename(2) over the existing symlink, so no window
# exists in which \`current\` is absent.
ln -sfn "$RELEASE_DIR" "$CURRENT.new"
mv -fT "$CURRENT.new" "$CURRENT"
FLIPPED=1
echo "[+] current -> $RELEASE_DIR (was: \${PREV:-<none>})"

systemctl restart "$UNIT"

${SETTLE_GATE_SH}

# ── The health gate. Five outcomes, deliberately distinguished:
#     ok=1  ready, serving the runId we shipped, settled → success
#     ok=0  never became ready within the window     → "not up"
#     ok=2  ready, but /api/health names another build → the flip did not take
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
  # Liveness alone would let a failed flip pass as success: the PREVIOUS build
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

# Gate passed: the previous extraction cache has no rollback value now, and on a
# box nobody SSHes into, disk-fill is the failure that takes the site down
# silently. Exactly one extracted bundle is left behind.
if [ "$MOVED" -eq 1 ]; then
  rm -rf -- "$STALE"
  echo "[=] pruned the previous extraction cache under $CACHE"
fi

echo "[ok] $UNIT is serving runId $RUN_ID"
printf '%s\\n' "$body"
`;
}
