#!/usr/bin/env bash
# Steps run inside the throwaway guest VM, in order, following docs/setup.md
# as literally as a brand-new user would read it.
#
# Each step is a bash function that ECHOES the shell command(s) it wants run
# in the guest — it is a command GENERATOR, not the command itself, so
# run.sh can log the exact text it sent before it ran anything.
#
# Every step also sets two sibling variables:
#   <fn>_DOC  — one line saying what docs/setup.md (or CLAUDE.md) says at
#               this point, so the summary reads as a diff against the docs.
#   <fn>_TAG  — one of:
#     from-docs             the command a new user reading the doc would run
#     documented-elsewhere   the fix exists in writing, just not in the doc
#                            that was supposed to cover this
#     undocumented-knowledge no doc says this; a new user has to guess or
#                            search the web to find it
#
# A step may also set <fn>_EXPECT_FAIL=1. That marks a blocker an earlier run
# already recorded, whose fix is the step right after it: the run records the
# failure and carries on instead of stopping. Only set it for a failure whose
# exact error is already written down in the run's findings.
#
# New steps get appended here as a baseline run discovers what else is
# missing, each with its own DOC/TAG. Do not edit an existing step to route
# around a failure — the failure it produces today IS the finding; add the
# fix as the NEXT step instead, so the run stays a legible diff against
# docs/setup.md.

REPO_URL="https://github.com/Conchylicultor/singularity"

step_01_baseline() {
  cat <<'CMD'
sw_vers
uname -m
whoami
CMD
}
step_01_baseline_DOC="Nothing in docs/setup.md — records the guest's starting state before any doc step runs."
step_01_baseline_TAG="from-docs"

step_02_clone() {
  cat <<CMD
git clone $REPO_URL ~/singularity
CMD
}
step_02_clone_DOC="Not stated explicitly, but a new user's first action reading the repo is cloning it."
step_02_clone_TAG="from-docs"
# Recorded finding (run 1): a clean Mac has no Xcode command-line tools, so
# the git that ships with macOS is only a stub. It answers with
# "xcode-select: note: No developer tools were found, requesting install."
# and exits 1. On a desktop the same thing pops an install dialog; over ssh
# there is nobody to click it. docs/setup.md never mentions this.
step_02_clone_EXPECT_FAIL=1

step_03_xcode_clt() {
  cat <<'CMD'
sudo touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
PROD=$(softwareupdate -l 2>/dev/null | grep -E '^\s*\*?\s*Label: Command Line Tools' | sed 's/^[^:]*: //' | tail -1)
echo "installing: $PROD"
sudo softwareupdate -i "$PROD" --verbose
sudo rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
xcode-select -p
git --version
CMD
}
step_03_xcode_clt_DOC="Nothing in docs/setup.md. A desktop user clicks Install in the dialog git triggers; this is the same install driven from a shell."
step_03_xcode_clt_TAG="undocumented-knowledge"

step_04_clone_retry() {
  cat <<CMD
git clone $REPO_URL ~/singularity
CMD
}
step_04_clone_retry_DOC="The clone from step 2, retried now that the command-line tools exist."
step_04_clone_retry_TAG="from-docs"

step_05_bun_before_brew() {
  cat <<'CMD'
brew install oven-sh/bun/bun
CMD
}
step_05_bun_before_brew_DOC="Prerequisites table in docs/setup.md: \`brew install oven-sh/bun/bun\`. The table never says to install Homebrew first."
step_05_bun_before_brew_TAG="from-docs"
# Recorded finding (run 1): "bash: line 1: brew: command not found" (exit
# 127). The prerequisite table's three install commands all start with
# `brew`, and no doc in the repo says to install Homebrew first.
step_05_bun_before_brew_EXPECT_FAIL=1

step_06_install_homebrew() {
  cat <<'CMD'
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
brew --version
CMD
}
step_06_install_homebrew_DOC="Not in docs/setup.md at all — this is the fix for step 3, found the way a new user would find it (Homebrew's own site), not from any Singularity doc."
step_06_install_homebrew_TAG="undocumented-knowledge"

step_07_bun() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install oven-sh/bun/bun
bun --version
CMD
}
step_07_bun_DOC="Prerequisites table in docs/setup.md: \`brew install oven-sh/bun/bun\` (retried now that Homebrew exists)."
step_07_bun_TAG="from-docs"

step_08_go() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install go
go version
CMD
}
step_08_go_DOC="Prerequisites table in docs/setup.md: \`brew install go\`."
step_08_go_TAG="from-docs"

step_09_postgres_client() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install postgresql@18
CMD
}
step_09_postgres_client_DOC="Prerequisites table in docs/setup.md: \`brew install postgresql@18\` — the client CLI only, the server is bundled."
step_09_postgres_client_TAG="from-docs"

step_10_hooks() {
  cat <<'CMD'
cd ~/singularity
git config core.hooksPath .githooks
CMD
}
step_10_hooks_DOC="Git hooks section of docs/setup.md: \`git config core.hooksPath .githooks\`, once per clone."
step_10_hooks_TAG="from-docs"

step_11_start() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
./singularity start
CMD
}
step_11_start_DOC="Root CLAUDE.md CLI section: \`./singularity start\` brings up the gateway — a one-time, system-level step."
step_11_start_TAG="from-docs"

step_12_build() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
./singularity build --allow-main
CMD
}
step_12_build_DOC="Root CLAUDE.md CLI section: \`./singularity build\`, run once against main to deploy the app for the first time."
step_12_build_TAG="from-docs"
# Recorded finding (run 1): the first build of a fresh clone fails after 62s
# with 'no database for "singularity" and no fork in flight after 60s'. The
# base database the whole app runs on is never created by anything in
# docs/setup.md. The error does name a fix (`./singularity db fork`), which
# is the next step.
step_12_build_EXPECT_FAIL=1

step_13_db_fork() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
./singularity db fork
CMD
}
step_13_db_fork_DOC="Not in docs/setup.md. The build's own failure message names this command, so a new user can find it — but only after the build fails."
step_13_db_fork_TAG="documented-elsewhere"
# Recorded finding (run 1): this is a dead end, and the wall a new user hits.
# `db fork` asks a RUNNING backend which tables to leave out of the copy:
#   "Could not read the fork exclusion set from any running backend:
#    http://singularity.localhost:9000/api/db/fork-exclusions -> 404
#    Start Singularity and retry ..."
# No backend can run until the app is built, and the build is what is asking
# for the database. The build's own advice therefore cannot be followed on a
# fresh install.
step_13_db_fork_EXPECT_FAIL=1

step_14_mise_setup() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install mise
cd ~/singularity
mise trust
mise install
CMD
}
step_14_mise_setup_DOC="Not in docs/setup.md, which never mentions mise. mise.toml pins the toolchain and its setup task claims to create the base database."
step_14_mise_setup_TAG="undocumented-knowledge"

step_15_createdb() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
createdb -h ~/.singularity/postgres/socket -p 5433 -U singularity singularity
./singularity apply-migrations
CMD
}
step_15_createdb_DOC="Nowhere in any doc. Reconstructed from mise.toml's setup task, but pointed at the embedded cluster socket instead of a system Postgres on 5432."
step_15_createdb_TAG="undocumented-knowledge"
# Recorded finding (run 1): `createdb` against the embedded cluster's socket
# works, but the command that is supposed to seed it crashes:
#   "[runtime-identity] this process has not declared a runtime namespace."
# So ./singularity apply-migrations — the CLI command that exists for exactly
# this fresh-clone case — is broken on main today. The database is left
# created but empty.
step_15_createdb_EXPECT_FAIL=1

step_16_build_retry() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
./singularity build --allow-main
CMD
}
step_16_build_retry_DOC="The build from step 12, retried now that a database exists."
step_16_build_retry_TAG="from-docs"
# Recorded finding (run 1): an EMPTY database is not enough. The build
# crashes with 'relation "build_runs" does not exist' — it writes to its own
# ledger table before anything has created the schema. Something has to
# apply the migrations first, and the command for that is the one that
# crashed in step 15.
step_16_build_retry_EXPECT_FAIL=1

step_17_gateway_restart() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
./singularity start --force
sleep 20
psql -h ~/.singularity/postgres/socket -p 5433 -U singularity -d singularity -tAc "select count(*) from information_schema.tables where table_schema = 'public'"
CMD
}
step_17_gateway_restart_DOC="Nowhere. A guess: a backend applies migrations when it boots, so restarting the gateway once the database exists might seed it."
step_17_gateway_restart_TAG="undocumented-knowledge"

step_18_build_retry2() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
./singularity build --allow-main
CMD
}
step_18_build_retry2_DOC="The build again, after the gateway restart."
step_18_build_retry2_TAG="from-docs"
# Recorded finding (run 1): restarting the gateway does not seed the base
# database either. Only __singularity_migrations appears; the build still
# crashes on the missing build_runs table. At this point every path a new
# user could find is exhausted — this is where a real install ends.
step_18_build_retry2_EXPECT_FAIL=1

# HARNESS-ONLY from here. No new user could find this: it applies the
# migration SQL files by hand, in filename order, and writes the ledger rows
# the runner would have written (each file name carries its own sha8). It
# exists only so one run can also reveal what breaks AFTER the database wall,
# instead of needing a second run once the wall is fixed.
step_19_apply_migrations_by_hand() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
PSQL="psql -h $HOME/.singularity/postgres/socket -p 5433 -U singularity -d singularity -v ON_ERROR_STOP=1 -q"
n=0
for f in plugins/database/plugins/migrations/data/*.sql; do
  base=$(basename "$f")
  hash=$(echo "$base" | sed -E 's/^[0-9]+_[0-9]+_([0-9a-f]+)__.*$/\1/')
  if $PSQL -tAc "select 1 from __singularity_migrations where hash = '$hash'" | grep -q 1; then continue; fi
  $PSQL -1 -f "$f" || { echo "FAILED applying $base"; exit 1; }
  $PSQL -c "insert into __singularity_migrations (hash, file) values ('$hash', '$base')" || exit 1
  n=$((n+1))
done
echo "applied $n migrations"
$PSQL -tAc "select count(*) from information_schema.tables where table_schema = 'public'"
CMD
}
step_19_apply_migrations_by_hand_DOC="Nothing — this is the harness reaching past the wall, not a step any user could take."
step_19_apply_migrations_by_hand_TAG="harness-only"

step_20_build_retry3() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
./singularity build --allow-main
CMD
}
step_20_build_retry3_DOC="The build again, with a fully migrated database behind it."
step_20_build_retry3_TAG="from-docs"
# Recorded finding (run 1): with a seeded database the build finally gets all
# the way to its checks and the frontend compiles — then one check crashes:
#   toolchain:resolved ... FAIL
#   threw instead of returning a result:
#   Error: Executable not found in $PATH: "<tool>"
# The toolchain is pinned in mise.toml, which docs/setup.md never mentions, and
# the check throws rather than reporting a failure it could name. The whole build is discarded for it.
step_20_build_retry3_EXPECT_FAIL=1

step_22_build_retry4() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/singularity
./singularity build --allow-main
CMD
}
step_22_build_retry4_DOC="The build again."
step_22_build_retry4_TAG="from-docs"
# Recorded finding (run 1): the same check now names the NEXT missing tool,
#   toolchain:resolved ... FAIL  Error: Executable not found in $PATH: "rustc"
# and each missing tool costs another full build (~5 min) to discover, one at
# a time. mise.toml pins three tools (bun, go, rust) and says of rust
# "end users need none of this" — yet the check demands it on every build.
step_22_build_retry4_EXPECT_FAIL=1

step_23_mise_path() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
SHIMS="$HOME/.local/share/mise/shims"
echo "export PATH=\"$SHIMS:\$PATH\"" >> ~/.bash_profile
echo "export PATH=\"$SHIMS:\$PATH\"" >> ~/.zprofile
export PATH="$SHIMS:$PATH"
for t in bun go rustc cargo; do printf "%-7s %s\n" "$t" "$(command -v $t || echo MISSING)"; done
CMD
}
step_23_mise_path_DOC="Not in any doc. mise installs the pinned tools but nothing puts them on the PATH, so the toolchain check cannot see them."
step_23_mise_path_TAG="undocumented-knowledge"

step_24_build_retry5() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
export PATH="$HOME/.local/share/mise/shims:$PATH"
cd ~/singularity
./singularity build --allow-main
CMD
}
step_24_build_retry5_DOC="The build again, with every pinned tool reachable."
step_24_build_retry5_TAG="from-docs"

step_25_curl_check() {
  cat <<'CMD'
curl -sS -o /dev/null -w '%{http_code}\n' http://singularity.localhost:9000/
CMD
}
step_25_curl_check_DOC="Root CLAUDE.md Ports section: the main namespace is always served at singularity.localhost:9000 — checks it actually answers."
step_25_curl_check_TAG="from-docs"

step_26_screenshot() {
  cat <<'CMD'
eval "$(/opt/homebrew/bin/brew shellenv)"
export PATH="$HOME/.local/share/mise/shims:$PATH"
cd ~/singularity
./singularity run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --out /tmp/clean-install-shot
ls -la /tmp/clean-install-shot*
CMD
}
step_26_screenshot_DOC="Root CLAUDE.md: the screenshot harness proves the deployed app actually renders, not just that the port answers."
step_26_screenshot_TAG="from-docs"

step_27_claude_cli() {
  cat <<'CMD'
command -v claude || echo "claude: MISSING"
ls ~/.local/bin/claude 2>&1 | head -1
CMD
}
step_27_claude_cli_DOC="Nothing in docs/setup.md mentions Claude Code, though mise.toml calls it an external prerequisite and every agent launch needs it."
step_27_claude_cli_TAG="from-docs"

STEPS=(
  step_01_baseline
  step_02_clone
  step_03_xcode_clt
  step_04_clone_retry
  step_05_bun_before_brew
  step_06_install_homebrew
  step_07_bun
  step_08_go
  step_09_postgres_client
  step_10_hooks
  step_11_start
  step_12_build
  step_13_db_fork
  step_14_mise_setup
  step_15_createdb
  step_16_build_retry
  step_17_gateway_restart
  step_18_build_retry2
  step_19_apply_migrations_by_hand
  step_20_build_retry3
  step_22_build_retry4
  step_23_mise_path
  step_24_build_retry5
  step_25_curl_check
  step_26_screenshot
  step_27_claude_cli
)
