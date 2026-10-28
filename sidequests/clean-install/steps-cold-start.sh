#!/usr/bin/env bash
# The cold-start benchmark: what a first install, and the first agent build
# after it, spend — phase by phase. Measurement only; nothing here is a step a
# user takes, so every step is `harness-only`.
#
#   # main.bundle: the tree under test WITH its history (`git bundle create
#   # main.bundle main`), as a real clone has it — a one-commit snapshot fails
#   # snapshot-chain-intact in the agent build. Its install.sh is piped in as
#   # COLD_START_INSTALL_SH.
#   COLD_START_INSTALL_SH=/tmp/r/tree/install.sh sidequests/clean-install/run.sh \
#     --steps steps-cold-start.sh --upload /tmp/r/main.bundle:/tmp/main.bundle
#
# Every line install.sh and the agent build print is prefixed with the seconds
# since the step started ([   12.3]), so the log alone gives each `==>` section
# and each build line its wall time. After each build, the build's own profile
# (spans), the type-check cost lines and the web-artifacts summary are printed
# into the step log, so the run directory holds everything the analysis reads.
#
# Same step format as steps.sh (see its header).

# Prefix each stdin line with the seconds since this filter started. zsh, not
# perl or bash 3.2: the vanilla guest has zsh with zsh/datetime, nothing else
# that keeps sub-second time.
STAMP='zsh -c '"'"'zmodload zsh/datetime; t0=$EPOCHREALTIME; while IFS= read -r l; do printf "[%7.1f] %s\n" $(( EPOCHREALTIME - t0 )) "$l"; done'"'"''

# The newest build's per-run artifacts under the namespace dirs matching $1 (a
# glob: at step 3 the newest profile in `*` is the install's build, so it
# needs no namespace name). A fresh install's data root is ~/.equin.
DUMP_BUILD='
prof=$(ls -t $HOME/.equin/worktrees/$1/build-profile-*.json 2>/dev/null | head -1)
dir=$(dirname "${prof:-.}")
echo "== build profile: $prof"
[ -n "$prof" ] && cat "$prof"
echo
chk=$(ls -t "$dir"/check-*.log 2>/dev/null | head -1)
echo "== check log: $chk"
[ -n "$chk" ] && grep -E "type-check|tsc repo|maxRSS|cpu [0-9]" "$chk" | cut -c1-600
echo "== check log tail"
[ -n "$chk" ] && tail -40 "$chk" | cut -c1-400
'

step_01_baseline() {
  cat <<'CMD'
sw_vers
uname -m
sysctl -n hw.ncpu hw.memsize
df -h ~ | tail -1
CMD
}
step_01_baseline_DOC="Nothing — records the guest's size."
step_01_baseline_TAG="harness-only"

step_02_install() {
  : "${COLD_START_INSTALL_SH:?set COLD_START_INSTALL_SH to the install.sh of the tree under test}"
  printf "set -o pipefail\ncat > /tmp/install.sh <<'INSTALL_SH_EOF'\n"
  cat "$COLD_START_INSTALL_SH"
  printf "INSTALL_SH_EOF\n"
  printf "/usr/bin/time -l bash /tmp/install.sh --repo /tmp/main.bundle 2>&1 < /dev/null | %s\n" "$STAMP"
}
step_02_install_DOC="install.sh end to end, every line timestamped, under time -l (total CPU and peak RSS of the installer's own process tree are NOT summed by time -l; only its direct child)."
step_02_install_TAG="harness-only"

step_03_install_build() {
  printf "set -- %s\n%s\n" "*" "$DUMP_BUILD"
}
step_03_install_build_DOC="The install's build: its profile, type-check cost lines and check log."
step_03_install_build_TAG="harness-only"

step_04_agent_build() {
  cat <<CMD
set -o pipefail
zsh -l -i -c 'set -e
# What an agent pane sets; without it conversation-trailer fails the build.
export EQUIN_CONVERSATION_ID=conv-bench-cold
cd ~/equin
git worktree add -q .claude/worktrees/att-bench-cold -b bench-cold
cd .claude/worktrees/att-bench-cold
./equin db fork
/usr/bin/time -l ./equin build' 2>&1 < /dev/null | $STAMP
CMD
}
step_04_agent_build_DOC="The first agent build after install: a fresh worktree, its DB fork, then a full ./equin build (every check)."
step_04_agent_build_TAG="harness-only"

step_05_agent_build_dump() {
  printf "set -- att-bench-cold\n%s\n" "$DUMP_BUILD"
}
step_05_agent_build_dump_DOC="The agent build's profile, type-check cost lines and check log."
step_05_agent_build_dump_TAG="harness-only"

step_06_store_sizes() {
  cat <<'CMD'
du -sh "$HOME/.equin"/cache/* 2>/dev/null | sort -h | tail -25
du -sh ~/.bun/install/cache ~/.local/share/mise ~/equin/node_modules 2>/dev/null
CMD
}
step_06_store_sizes_DOC="What the stores hold after install + one agent build."
step_06_store_sizes_TAG="harness-only"

STEPS=(
  step_01_baseline
  step_02_install
  step_03_install_build
  step_04_agent_build
  step_05_agent_build_dump
  step_06_store_sizes
)
