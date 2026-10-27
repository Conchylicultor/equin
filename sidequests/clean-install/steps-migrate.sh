#!/usr/bin/env bash
# The data-dir migration (`./equin data-dir migrate`), rehearsed end to end on
# a throwaway install: install a tree from BEFORE the move (legacy data dir,
# old gateway label), use it, check out the tree under test, migrate, and
# check what a user would: the old dir and label are gone, the app answers,
# stored paths moved, and it comes back after a reboot.
#
#   # old.bundle / new.bundle: snapshots (see CLAUDE.md's recipe) of a pre-move
#   # commit and of the tree under test; old/ is the pre-move tree extracted.
#   MIGRATE_OLD_INSTALL_SH=/tmp/r/old/install.sh sidequests/clean-install/run.sh \
#     --steps steps-migrate.sh \
#     --upload /tmp/r/old.bundle:/tmp/old.bundle --upload /tmp/r/new.bundle:/tmp/new.bundle
#
# The guest has no git before the installer brings the command-line tools, so
# the old installer's body travels in the step's text (MIGRATE_OLD_INSTALL_SH,
# read on the host), the way steps-install.sh's CLEAN_INSTALL_SH does.
#
# Same step format as steps.sh (see its header). Every step is `harness-only`:
# the migration is a maintenance command, not a documented install path.
#
# This file mirrors `LEGACY_IDS.dataDirName` (the `LEGACY=` lines) and
# `defaultCheckoutDir` (the old installer's checkout).

step_01_install_old() {
  : "${MIGRATE_OLD_INSTALL_SH:?set MIGRATE_OLD_INSTALL_SH to the install.sh of the pre-move tree}"
  printf "set -o pipefail\ncat > /tmp/install.sh <<'INSTALL_SH_EOF'\n"
  cat "$MIGRATE_OLD_INSTALL_SH"
  printf "INSTALL_SH_EOF\n"
  printf "cat /tmp/install.sh | bash -s -- --repo /tmp/old.bundle\n"
}
step_01_install_old_DOC="Install the pre-move tree (legacy data dir, old label)."
step_01_install_old_TAG="harness-only"

step_02_old_layout() {
  cat <<'CMD'
LEGACY="$HOME/.singularity"
fail() { echo "FAIL: $*"; exit 1; }
test -d "$LEGACY" && ! test -L "$LEGACY" || fail "no legacy data dir"
test -e "$HOME/.equin" && fail "a current data dir already exists"
launchctl print "gui/$(id -u)/dev.singularity.gateway" >/dev/null || fail "old label not loaded"
code=$(curl -sS -o /dev/null -w '%{http_code}' http://equin.localhost:9000/); echo "http $code"
[ "$code" = 200 ] || fail "the app does not answer"
echo "legacy layout, old label, app answers"
CMD
}
step_02_old_layout_DOC="The install is on the legacy layout and serves."
step_02_old_layout_TAG="harness-only"

step_03_seed() {
  # A scratch conversation's transcript dir, keyed by a cwd under the root, and
  # a text file under state/ that names the root — the two shapes the
  # rewrite must move that a fresh install does not create by itself.
  cat <<'CMD'
LEGACY="$HOME/.singularity"
set -e
root="$LEGACY"
mkdir -p "$root/state/workspaces/att-seed"
enc=$(printf '%s' "$root/state/workspaces/att-seed" | sed 's/[^a-zA-Z0-9]/-/g')
mkdir -p "$HOME/.claude/projects/$enc"
printf '{"type":"user","cwd":"%s"}\n' "$root/state/workspaces/att-seed" > "$HOME/.claude/projects/$enc/seed.jsonl"
mkdir -p "$root/state/config"
printf '{"seeded":"%s/state/workspaces/att-seed"}\n' "$root" > "$root/state/config/seed-path.json"
CMD
}
step_03_seed_DOC="Seed a Claude transcript dir and a stored path."
step_03_seed_TAG="harness-only"

step_04_checkout_new() {
  cat <<'CMD'
set -e
cd ~/singularity 2>/dev/null || cd ~/equin
git fetch /tmp/new.bundle main
git reset --hard FETCH_HEAD
zsh -l -i -c './equin data-dir migrate'
CMD
}
step_04_checkout_new_DOC="Check out the tree under test; the dry run prints the plan."
step_04_checkout_new_TAG="harness-only"

step_05_migrate() {
  cat <<'CMD'
cd ~/singularity 2>/dev/null || cd ~/equin
zsh -l -i -c './equin data-dir migrate --apply'
CMD
}
step_05_migrate_DOC="./equin data-dir migrate --apply."
step_05_migrate_TAG="harness-only"

step_06_after() {
  cat <<'CMD'
LEGACY="$HOME/.singularity"
fail() { echo "FAIL: $*"; exit 1; }
{ test -e "$LEGACY" || test -L "$LEGACY"; } && fail "the legacy data dir (or its link) is still there"
test -d "$HOME/.equin" || fail "no ~/.equin"
launchctl print "gui/$(id -u)/dev.equin.gateway" >/dev/null || fail "dev.equin.gateway not loaded"
launchctl print "gui/$(id -u)/dev.singularity.gateway" >/dev/null 2>&1 && fail "the old label is still loaded"
ls ~/Library/LaunchAgents/ | grep -q "dev\.singularity\." && fail "the old label's plist is still installed"
code=$(curl -sS -o /dev/null -w '%{http_code}' http://equin.localhost:9000/); echo "http $code"
[ "$code" = 200 ] || fail "the app does not answer"
grep -q "$HOME/.equin/state/workspaces/att-seed" "$HOME/.equin/state/config/seed-path.json" || fail "stored path not rewritten"
ls "$HOME/.claude/projects" | grep -q -- "-equin-state-workspaces-att-seed" || fail "transcript dir not renamed"
grep -q "$LEGACY/" "$HOME/.equin/state/db-config/database.json" && fail "database.json still names the legacy dir"
cd ~/singularity 2>/dev/null || cd ~/equin
zsh -l -i -c './equin data-dir migrate' > /tmp/second-run.txt 2>&1; cat /tmp/second-run.txt
grep -q "Nothing to do" /tmp/second-run.txt || fail "a second run still has work"
echo "all checks passed"
CMD
}
step_06_after_DOC="The legacy dir and label are gone, the app answers, stored paths moved, a second run has nothing to do."
step_06_after_TAG="harness-only"

step_07_reboot() {
  echo "sudo shutdown -r now   # run.sh reboots and waits for ssh (step_07_reboot_REBOOT=1)"
}
step_07_reboot_DOC="Reboot."
step_07_reboot_TAG="harness-only"
step_07_reboot_REBOOT=1

step_08_after_reboot() {
  cat <<'CMD'
for i in $(seq 1 100); do
  code=$(curl -sS -o /dev/null -m 5 -w '%{http_code}' http://equin.localhost:9000/ 2>/dev/null || true)
  [ "$code" = 200 ] && { echo "http 200 after ~$((i * 3))s"; exit 0; }
  sleep 3
done
echo "http ${code:-none} — the app did not come back"
launchctl print "gui/$(id -u)/dev.equin.gateway" 2>&1 | head -20
exit 1
CMD
}
step_08_after_reboot_DOC="After a reboot the migrated install comes back under the new label."
step_08_after_reboot_TAG="harness-only"

STEPS=(
  step_01_install_old
  step_02_old_layout
  step_03_seed
  step_04_checkout_new
  step_05_migrate
  step_06_after
  step_07_reboot
  step_08_after_reboot
)
