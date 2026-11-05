#!/usr/bin/env bash
# Build pipeline, step 1: what the NON-check ./equin build steps (codegen,
# migration generation, plugin docs, frontend pipeline) cost, cold and warm, on
# a quiet 6-core / 12 GB Tart guest. Measurement only, so every step is
# `harness-only`. Plan: research/2026-10-28-global-build-pipeline-step1-measure.md.
#
# ---- Invocation (from the repo root of the tree under test) -------------------
#
#   # 1. The tree under test WITH history, uncommitted files included (a real
#   #    clone has history; a one-commit snapshot fails snapshot-chain-intact).
#   R=/tmp/bp-run; rm -rf $R; mkdir -p $R/tree
#   rsync -a --exclude node_modules --exclude .claude/worktrees --exclude .git ./ $R/tree/
#   git -C $R/tree init -q -b main
#   git -C $R/tree add -A && git -C $R/tree -c user.email=a@b -c user.name=bp commit -qm snapshot
#   git -C $R/tree bundle create $R/main.bundle main
#   #    (Prefer a bundle WITH main's real history: `git bundle create $R/main.bundle
#   #    main` run in a clone of the repo whose main is the tree under test; the
#   #    CLAUDE.md "snapshot it into a git bundle" recipe is the one-commit form.)
#
#   # 2. Run. --keep leaves the VM up so the results can be copied out.
#   BUILD_PIPELINE_INSTALL_SH=$R/tree/install.sh \
#     sidequests/clean-install/run.sh --steps steps-build-pipeline.sh \
#       --upload $R/main.bundle:/tmp/main.bundle --keep --name si-clean-bp
#
#   # 3. Copy the results back (run.sh already printed the guest IP; or
#   #    `~/.local/bin/tart ip si-clean-bp`). The run dir (~/.equin-clean-install/
#   #    si-clean-bp/) holds one log per step incl. every profile JSON; the raw
#   #    cpu-profiles are in the last step's tarball:
#   OUT=~/.equin-clean-install/si-clean-bp
#   scp -i $OUT/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
#     admin@$(~/.local/bin/tart ip si-clean-bp):/tmp/bp-out.tgz $OUT/bp-out.tgz
#   #    (opts = SSH_OPTS in run.sh.)
#
#   # 4. Delete the VM yourself: tart stop si-clean-bp && tart delete si-clean-bp
#
# Resume after a failure with --keep --name si-clean-bp --from N.
#
# ---- What runs -----------------------------------------------------------------
#  C0   cold x3: ./equin build --hermetic --composition <main> (the main
#       composition), each with a FRESH data root ($HOME/bp-cold-N, a real path:
#       a /tmp root fails the browser-host build through the /tmp -> /private/tmp
#       symlink) and a FRESH Bun transpiler cache ($HOME/bp-tcache-N).
#       Run 1 follows `sudo purge` (cold OS file cache): label C0.
#       Runs 2 and 3 have the OS file cache warm from run 1: label C1 (stores
#       cold, file cache warm). The three are therefore C0, C1, C1.
#  W0   warm, nothing changed: the first agent-worktree build (primes the
#       per-worktree fingerprints: labelled W0-prime, it is also W3-like), then
#       3 x `build --skip-checks`, then one full `./equin build` (with checks).
#  FSU  one more unchanged W0 build under sudo fs_usage (file-system call counts
#       per process; step 3c, research/2026-11-03-global-build-pipeline-step3c-repo-snapshot.md).
#  W1   plugin body edit x3: a comment line appended to a keyboard-party web file.
#  W2   schema edit x3: a nullable column added to app_usage_daily (the
#       migration is generated inside the VM; each run adds another column).
#  W4   server body edit x3: a comment line appended to a server file of a
#       browser-host graph member (apps-core/app-usage) — the host's rebuild case.
#  W3   fresh worktree from main, stores warm x2 (db fork + build --skip-checks).
#  CF   cold x3: the frontend pipeline alone from an empty data root
#       (web-artifacts/scripts/measure-frontend-cold.ts), without the cold
#       checks competing for the cores; BUILD_PIPELINE_CF_ARGS is appended
#       (step 3b, research/2026-10-30-global-build-pipeline-step3b-batched-artifacts-and-repo-snapshot.md).
#  RUN  $BUILD_PIPELINE_RUN (guest zsh code, run in ~/equin with bp.zsh loaded),
#       for a spike or measurement script. Skipped when unset.
#  ISO  measure-build-steps.ts, one run per step-order preset, in a clean worktree.
#       BUILD_PIPELINE_SKIP_ISO=1 skips it (for a step that leaves codegen alone).
#
# BUILD_PIPELINE_STEPS="baseline install lib cf": run only the named steps (by
# slug), e.g. one scenario on a fresh VM. Unset: every step.
#
# Profiling: every build runs with BUN_OPTIONS="--cpu-prof-md --cpu-prof-dir=...";
# Bun forwards it to every bun child (build, drizzle-kit probe, workers), one .md
# per process. Everything lands under $HOME/bp-out/<label>/ (build.log, profile.json,
# prof/*.md, sys.txt); the last step tars it to /tmp/bp-out.tgz.
# Host load: the guest cannot see it; sys.txt records guest uptime / loadavg /
# vm_stat before and after each scenario. The parent records host load itself.
#
# Same step format as steps.sh (see its header).

# The main composition's id (MAIN_COMPOSITION_ID = LEGACY_IDS.mainNamespace),
# read from the tree under test rather than spelled here.
COMPOSITION="${BUILD_PIPELINE_COMPOSITION:-$(sed -nE 's/^ *mainNamespace: "([^"]+)",$/\1/p' "$(dirname "${BASH_SOURCE[0]}")/../../plugins/framework/plugins/product-name/core/internal/legacy-ids.ts" | head -1)}"
: "${COMPOSITION:?could not read LEGACY_IDS.mainNamespace}"

# Prefix each stdin line with the seconds since this filter started (as
# steps-cold-start.sh); also defined guest-side as bp_stamp in bp.zsh.
STAMP='zsh -c '"'"'zmodload zsh/datetime; t0=$EPOCHREALTIME; while IFS= read -r l; do printf "[%7.1f] %s\n" $(( EPOCHREALTIME - t0 )) "$l"; done'"'"''

# Run $1 (zsh code) in the guest's interactive login zsh with the helper
# library loaded; output stamped.
guest_zsh() {
  printf "set -o pipefail\nzsh -l -i -c 'source \$HOME/bp.zsh; %s' 2>&1 < /dev/null | %s\n" "$1" "$STAMP"
}

step_01_baseline() {
  cat <<'CMD'
sw_vers
uname -m
sysctl -n hw.ncpu hw.memsize
df -h ~ | tail -1
uptime
CMD
}
step_01_baseline_DOC="Nothing — records the guest's size."
step_01_baseline_TAG="harness-only"

step_02_install() {
  : "${BUILD_PIPELINE_INSTALL_SH:?set BUILD_PIPELINE_INSTALL_SH to the install.sh of the tree under test}"
  printf "set -o pipefail\ncat > /tmp/install.sh <<'INSTALL_SH_EOF'\n"
  cat "$BUILD_PIPELINE_INSTALL_SH"
  printf "INSTALL_SH_EOF\n"
  printf "/usr/bin/time -l bash /tmp/install.sh --repo /tmp/main.bundle 2>&1 < /dev/null | %s\n" "$STAMP"
}
step_02_install_DOC="install.sh end to end from the uploaded bundle (the tree under test, with history); also leaves the install's own warm stores under ~/.equin."
step_02_install_TAG="harness-only"

step_03_lib() {
  cat <<'CMD'
mkdir -p "$HOME/bp-out"
cat > "$HOME/bp.zsh" <<'BPEOF'
# Helper library for steps-build-pipeline.sh (guest side, zsh).
zmodload zsh/datetime
setopt pipefail

bp_stamp() {
  local l t0=$EPOCHREALTIME
  while IFS= read -r l; do printf "[%7.1f] %s\n" $(( EPOCHREALTIME - t0 )) "$l"; done
}

# Guest-visible load. The host's load is invisible from here.
bp_sys() {
  echo "== sys $1 $(date +%T)"
  uptime
  sysctl -n vm.loadavg
  vm_stat | head -8
}

# bp_build LABEL PROFILE_GLOB -- CMD...   (CMD gets BUN_OPTIONS cpu-prof via env)
# PROFILE_GLOB: where this build's build-profile-*.json lands.
bp_build() {
  local label=$1 pglob=$2; shift 3
  local out="$HOME/bp-out/$label" rc
  rm -rf "$out"; mkdir -p "$out/prof"
  { bp_sys "$label before" } 2>&1 | tee -a "$out/sys.txt"
  echo "== build $label: $*"
  /usr/bin/time -l env BUN_OPTIONS="--cpu-prof-md --cpu-prof-dir=$out/prof" "$@" 2>&1 | bp_stamp | tee "$out/build.log"
  rc=${pipestatus[1]}
  { bp_sys "$label after" } 2>&1 | tee -a "$out/sys.txt"
  echo "== time -l ($label)"
  grep -E ' (real|user|sys) |maximum resident|peak memory|involuntary|page (faults|reclaims)' "$out/build.log" | cut -c1-200
  local prof; prof=$(ls -t ${~pglob} 2>/dev/null | head -1)
  echo "== build profile ($label): ${prof:-NONE FOUND (glob $pglob)}"
  if [ -n "$prof" ]; then cp "$prof" "$out/profile.json"; cat "$prof"; echo; fi
  echo "== cpu-prof files ($label)"
  ls -l "$out/prof" | cut -c1-200
  local f
  for f in $(find "$out/prof" -maxdepth 1 -name '*.md' -size +20k 2>/dev/null); do
    echo "-- $f (top section)"; head -12 "$f" | cut -c1-300
  done
  return $rc
}

# bp_worktree NAME : worktree off the checkout's main HEAD + db fork.
bp_worktree() {
  export EQUIN_CONVERSATION_ID=conv-bench-$1
  cd ~/equin
  # Idempotent: a resumed run (--from) may find a half-made one from before.
  if [ -d .claude/worktrees/att-$1 ]; then git worktree remove --force .claude/worktrees/att-$1; fi
  git branch -D $1 2>/dev/null
  git worktree add -q .claude/worktrees/att-$1 -b $1
  cd .claude/worktrees/att-$1
  ./equin db fork
}
# bp_addcol N FILE : add a nullable integer column bpProbeN after lastOpenedAt.
bp_addcol() {
  BPN=$1 perl -0pi -e 's/(  lastOpenedAt: timestamp\("last_opened_at", \{ withTimezone: true \}\),\n)/$1 . "  bpProbe$ENV{BPN}: integer(\"bp_probe_$ENV{BPN}\"),\n"/e' "$2"
}
BPEOF
cat "$HOME/bp.zsh" | head -3
CMD
}
step_03_lib_DOC="Writes the guest-side helper library (bp.zsh: timestamping, load snapshots, the profiled+timed build wrapper)."
step_03_lib_TAG="harness-only"

step_04_cold_c0() {
  # Cold file cache for the first run only: `sudo purge` (the guest's admin has
  # passwordless sudo). Fresh data root + fresh transpiler cache, real $HOME paths.
  guest_zsh '
export EQUIN_CONVERSATION_ID=conv-bench-cold
sudo purge
rm -rf $HOME/bp-cold-1 $HOME/bp-tcache-1; mkdir -p $HOME/bp-cold-1 $HOME/bp-tcache-1
cd ~/equin
bp_build C0-1 "$HOME/bp-cold-1/worktrees/*/build-profile-*.json" -- env EQUIN_DIR=$HOME/bp-cold-1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=$HOME/bp-tcache-1 ./equin build --hermetic --composition '"$COMPOSITION"'
'
}
step_04_cold_c0_DOC="C0: hermetic build of the main composition, empty data root, empty transpiler cache, cold OS file cache (sudo purge)."
step_04_cold_c0_TAG="harness-only"

step_05_cold_c1() {
  guest_zsh '
export EQUIN_CONVERSATION_ID=conv-bench-cold
cd ~/equin
for n in 2 3; do
  rm -rf $HOME/bp-cold-$n $HOME/bp-tcache-$n; mkdir -p $HOME/bp-cold-$n $HOME/bp-tcache-$n
  bp_build C1-$n "$HOME/bp-cold-$n/worktrees/*/build-profile-*.json" -- env EQUIN_DIR=$HOME/bp-cold-$n BUN_RUNTIME_TRANSPILER_CACHE_PATH=$HOME/bp-tcache-$n ./equin build --hermetic --composition '"$COMPOSITION"'
done
'
}
step_05_cold_c1_DOC="C1 x2: the same cold-store build with the OS file cache warm from C0 (runs 2 and 3 of the three cold runs)."
step_05_cold_c1_TAG="harness-only"

step_06_w0() {
  guest_zsh '
bp_worktree bp-w0
P="$HOME/.equin/worktrees/att-bp-w0/build-profile-*.json"
bp_build W0-prime "$P" -- ./equin build --skip-checks
for n in 1 2 3; do bp_build W0-$n "$P" -- ./equin build --skip-checks; done
bp_build W0-full "$P" -- ./equin build
'
}
step_06_w0_DOC="W0: fresh agent worktree + db fork; the priming build (per-worktree fingerprints empty), 3 unchanged --skip-checks builds, one full build with checks."
step_06_w0_TAG="harness-only"

step_15_fsu() {
  # One more unchanged build in the (still clean) W0 worktree, under a
  # system-wide `fs_usage` — the guest is otherwise idle. Counts every
  # file-system call per (call, process name). The build's processes are bun,
  # git and the renamed ones (`equin · <kind> · att-…`: the last word is all a
  # whitespace split keeps, and LC_ALL=C because the `·` is not ASCII).
  # (No single quote in the guest code: guest_zsh wraps it in zsh -c '…'.)
  guest_zsh '
export EQUIN_CONVERSATION_ID=conv-bench-bp-w0
cd ~/equin/.claude/worktrees/att-bp-w0
git status --short | head
sudo fs_usage -w -f filesys > $HOME/bp-out/fsu.raw 2>/dev/null &
FSU=$!
sleep 3
bp_build FSU-W0 "$HOME/.equin/worktrees/att-bp-w0/build-profile-*.json" -- ./equin build --skip-checks
sleep 1
sudo pkill -INT -x fs_usage; wait $FSU 2>/dev/null
echo "== fs_usage: calls by process (top 60)"
LC_ALL=C awk "NF > 3 { p = \$NF; sub(/\\.[0-9]+\$/, \"\", p); c[\$2 \" \" p]++ } END { for (k in c) print c[k], k }" $HOME/bp-out/fsu.raw | LC_ALL=C sort -rn | tee $HOME/bp-out/fsu-counts.txt | head -60
echo "== fs_usage: totals for the build (bun, git, att-*)"
LC_ALL=C awk "\$3 ~ /^(bun|git|att-)/ { t[\$2] += \$1 } END { for (k in t) print t[k], k }" $HOME/bp-out/fsu-counts.txt | LC_ALL=C sort -rn | head -25
gzip -f $HOME/bp-out/fsu.raw
'
}
step_15_fsu_DOC="FSU: one unchanged build --skip-checks in the W0 worktree under sudo fs_usage -f filesys; per-call counts for the build's processes (bun, git)."
step_15_fsu_TAG="harness-only"

step_07_w1() {
  guest_zsh '
export EQUIN_CONVERSATION_ID=conv-bench-bp-w0
cd ~/equin/.claude/worktrees/att-bp-w0
P="$HOME/.equin/worktrees/att-bp-w0/build-profile-*.json"
F=plugins/apps/plugins/keyboard-party/plugins/party/web/components/party-controls.tsx
for n in 1 2 3; do
  echo "// bp-w1-$n" >> $F
  bp_build W1-$n "$P" -- ./equin build --skip-checks
done
'
}
step_07_w1_DOC="W1 x3: one comment line appended to a leaf plugin's web .tsx (keyboard-party/party), then build --skip-checks."
step_07_w1_TAG="harness-only"

step_08_w2() {
  guest_zsh '
export EQUIN_CONVERSATION_ID=conv-bench-bp-w0
cd ~/equin/.claude/worktrees/att-bp-w0
P="$HOME/.equin/worktrees/att-bp-w0/build-profile-*.json"
F=plugins/apps-core/plugins/app-usage/server/internal/tables.ts
for n in 1 2 3; do
  bp_addcol $n $F
  git diff --stat -- $F
  # A schema change needs a migration name, or the build refuses it.
  bp_build W2-$n "$P" -- ./equin build --skip-checks --migration-name bp_probe_$n
done
git status --short | head
'
}
step_08_w2_DOC="W2 x3: a nullable column added to app_usage_daily's table (a migration is generated each run), then build --skip-checks."
step_08_w2_TAG="harness-only"

step_09_w4() {
  guest_zsh '
export EQUIN_CONVERSATION_ID=conv-bench-bp-w0
cd ~/equin/.claude/worktrees/att-bp-w0
P="$HOME/.equin/worktrees/att-bp-w0/build-profile-*.json"
F=plugins/apps-core/plugins/app-usage/server/internal/routes.ts
for n in 1 2 3; do
  echo "// bp-w4-$n" >> $F
  bp_build W4-$n "$P" -- ./equin build --skip-checks
done
'
}
step_09_w4_DOC="W4 x3: one comment line appended to a server file of a browser-host graph member (apps-core/app-usage), then build --skip-checks. The browser host's own rebuild case."
step_09_w4_TAG="harness-only"

step_10_w3() {
  guest_zsh '
for n in a b; do
  bp_worktree bp-w3$n
  bp_build W3-$n "$HOME/.equin/worktrees/att-bp-w3$n/build-profile-*.json" -- ./equin build --skip-checks
done
'
}
step_10_w3_DOC="W3 x2: two more fresh worktrees from main, db fork each, build --skip-checks with the shared stores warm."
step_10_w3_TAG="harness-only"

step_11_iso() {
  # BUILD_PIPELINE_SKIP_ISO=1: skip (a step that does not touch codegen).
  if [ -n "${BUILD_PIPELINE_SKIP_ISO:-}" ]; then echo 'echo "ISO skipped (BUILD_PIPELINE_SKIP_ISO)"'; return; fi
  # No BUN_OPTIONS here: the per-step timings should not carry profiler overhead.
  # measure-build-steps.ts is written by another agent; it must exist in the tree.
  guest_zsh '
bp_worktree bp-iso
for order in pipeline docs-first guard-first tree-only migrations-only; do
  bp_sys "iso $order before"
  /usr/bin/time -l ./equin run plugins/framework/plugins/tooling/plugins/codegen/scripts/measure-build-steps.ts --order $order --json $HOME/bp-out/steps-$order.json 2>&1 | bp_stamp
  bp_sys "iso $order after"
  echo "== steps-$order.json"; cat $HOME/bp-out/steps-$order.json; echo
done
'
}
step_11_iso_DOC="Per-step isolation: measure-build-steps.ts under each order preset (pipeline, docs-first, guard-first, tree-only, migrations-only) in a clean worktree."
step_11_iso_TAG="harness-only"

step_12_collect() {
  cat <<'CMD'
set -e
cd "$HOME"
du -sh "$HOME/bp-out" "$HOME/.equin"/cache/* 2>/dev/null | sort -h | tail -15
tar czf /tmp/bp-out.tgz bp-out
ls -l /tmp/bp-out.tgz
CMD
}
step_12_collect_DOC="Tars $HOME/bp-out (build logs, profile JSONs, cpu-prof md, step JSONs) to /tmp/bp-out.tgz for scp."
step_12_collect_TAG="harness-only"

step_13_cf() {
  # The frontend pipeline alone, cold (measure-frontend-cold.ts: an empty data
  # root per run, nothing else running). `build --hermetic` refuses
  # --skip-checks, so a cold build always ran its checks beside the frontend.
  # BUILD_PIPELINE_CF_ARGS: e.g. "--threads auto" (the build's pooled builder).
  guest_zsh '
cd ~/equin
bp_sys "cf before"
./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/measure-frontend-cold.ts --runs 3 --json $HOME/bp-out/cf.json '"${BUILD_PIPELINE_CF_ARGS:-}"' 2>&1 | grep -E "cold frontend|^  artifacts:"
bp_sys "cf after"
echo "== cf.json"; cat $HOME/bp-out/cf.json; echo
'
}
step_13_cf_DOC="CF x3: the frontend pipeline alone from an empty data root (measure-frontend-cold.ts), \$BUILD_PIPELINE_CF_ARGS appended."
step_13_cf_TAG="harness-only"

step_14_run() {
  if [ -z "${BUILD_PIPELINE_RUN:-}" ]; then echo 'echo "RUN skipped (BUILD_PIPELINE_RUN unset)"'; return; fi
  guest_zsh "cd ~/equin; $BUILD_PIPELINE_RUN"
}
step_14_run_DOC="RUN: \$BUILD_PIPELINE_RUN in ~/equin (a spike or measurement script)."
step_14_run_TAG="harness-only"

step_16_cc() {
  # Cold codegen alone (step 5, research/2026-11-04-global-build-pipeline-step5-migrations-verdict-and-cold-records.md):
  # measure-build-steps.ts --order pipeline from an EMPTY data root and an
  # empty transpiler cache, OS file cache warm, under --cpu-prof-md, in two
  # trees: the tree under test (with the shared SQLite record store: --records,
  # its misses made in-process and, step 6, on the build's record worker
  # threads: --workers ideal) and $BUILD_PIPELINE_CC_BASE
  # (a commit of the bundle's history, e.g. main before plugin records),
  # checked out as a second worktree and installed. x$BUILD_PIPELINE_CC_RUNS (2).
  guest_zsh '
bp_cc() {
  local label=$1 dir=$2; shift 2
  local out="$HOME/bp-out/$label" n
  for n in $(seq 1 '"${BUILD_PIPELINE_CC_RUNS:-2}"'); do
    rm -rf "$out-$n" $HOME/bp-ccd $HOME/bp-cct; mkdir -p "$out-$n/prof" $HOME/bp-ccd $HOME/bp-cct
    bp_sys "$label-$n before" > "$out-$n/sys.txt"
    echo "== cc $label-$n: $*"
    (cd $dir && /usr/bin/time -l env EQUIN_DIR=$HOME/bp-ccd BUN_RUNTIME_TRANSPILER_CACHE_PATH=$HOME/bp-cct BUN_OPTIONS="--cpu-prof-md --cpu-prof-dir=$out-$n/prof" ./equin run plugins/framework/plugins/tooling/plugins/codegen/scripts/measure-build-steps.ts --order pipeline --json "$out-$n/steps.json" "$@") 2>&1 | bp_stamp | tail -40
    echo "== steps.json ($label-$n)"; cat "$out-$n/steps.json"; echo
    (cd $dir && git status --short | head -5)
  done
}
cd ~/equin
if [ -n "'"${BUILD_PIPELINE_CC_BASE:-}"'" ]; then
  if [ ! -d $HOME/bp-base ]; then git worktree add -q --detach $HOME/bp-base "'"${BUILD_PIPELINE_CC_BASE:-}"'"; (cd $HOME/bp-base && ./equin install 2>&1 | tail -3); fi
  bp_cc CC-base $HOME/bp-base
fi
bp_cc CC-records ~/equin --records
bp_cc CC-pooled ~/equin --records --workers ideal
'
}
step_16_cc_DOC="CC: cold codegen alone (measure-build-steps --order pipeline, empty data root and transpiler cache, cpu-prof) in the tree under test (--records in-process, and on record workers) and in \$BUILD_PIPELINE_CC_BASE."
step_16_cc_TAG="harness-only"

step_17_w5() {
  # A body edit inside the schema files' import closure, in no schema file
  # (step 5): the drizzle-kit verdict misses, and the load probe's tip
  # comparison answers "nothing to generate" without drizzle-kit.
  guest_zsh '
export EQUIN_CONVERSATION_ID=conv-bench-bp-w0
cd ~/equin/.claude/worktrees/att-bp-w0
P="$HOME/.equin/worktrees/att-bp-w0/build-profile-*.json"
F=plugins/fields/plugins/text/plugins/config/core/internal/text.ts
for n in 1 2 3; do
  echo "// bp-w5-$n" >> $F
  bp_build W5-$n "$P" -- ./equin build --skip-checks
done
'
}
step_17_w5_DOC="W5 x3: one comment line appended to a module the schema files import (fields/text/config), in no schema file, then build --skip-checks."
step_17_w5_TAG="harness-only"

STEPS=(
  step_01_baseline
  step_02_install
  step_03_lib
  step_04_cold_c0
  step_05_cold_c1
  step_06_w0
  step_15_fsu
  step_07_w1
  step_08_w2
  step_09_w4
  step_17_w5
  step_10_w3
  step_11_iso
  step_13_cf
  step_14_run
  step_16_cc
  step_12_collect
)

if [ -n "${BUILD_PIPELINE_STEPS:-}" ]; then
  _bp_kept=()
  for _bp_fn in "${STEPS[@]}"; do
    for _bp_slug in $BUILD_PIPELINE_STEPS; do
      [[ "$_bp_fn" == step_[0-9]*_"$_bp_slug" ]] && _bp_kept+=("$_bp_fn")
    done
  done
  STEPS=("${_bp_kept[@]}")
fi
