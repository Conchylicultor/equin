# Setup

One-time environment setup for developing equin.

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/Conchylicultor/singularity/main/install.sh | bash
```

Or `./install.sh` from inside a clone or fork you already have. Options:
`--dir <path>` (default `~/equin`), `--repo <url>` (your fork),
`--no-shell-rc`; piped, pass them after `bash -s --`. It runs the steps
below (the Claude Code sign-in last, offered once the app is up), skipping
whatever is already done, so re-running it resumes
where it stopped. It lists what it will change before changing anything.

## Install, step by step

What [`install.sh`](../install.sh) does. One pass, in order, on macOS (Linux
notes inline). Every step is a prerequisite of the next.

```sh
# 1. Xcode command-line tools: git, and the C linker Rust builds with.
#    (Linux: git, curl and build-essential through apt, one sudo; plus lingering.)
xcode-select --install

# 2. mise, activated in your shell: it installs the exact Bun, Go, tmux and Rust
#    releases mise.lock records. Use ~/.bashrc and `activate bash` for bash.
curl https://mise.run | sh
echo 'eval "$(~/.local/bin/mise activate zsh)"' >> ~/.zshrc
exec zsh    # a new shell, with mise active

# 3. Claude Code, signed in: every agent the app launches runs on it.
curl -fsSL https://claude.ai/install.sh | bash
claude auth login

# 4. The repo, and its toolchain.
git clone <repo url> <dir> && cd <dir>
mise trust && mise install   # trust this checkout's mise.toml, then install

# 5. The app.
./equin start               # compiles and starts the gateway, and brings up Postgres
./equin build --allow-main --skip-checks  # builds the app and deploys it
```

`mise install` also runs the repo's `setup` task (trusts every worktree's
`mise.toml`, points git at the repo's hooks) and ends with the **doctor**, which
names every missing prerequisite at once, each with the command that fixes it.
Continue only once it says `all required present`. Claude Code is the one
*recommended* item: the doctor names it with its fix but does not stop on it,
since the app builds and runs without it — only agents need it, and the app
says so where they are launched (the health report's Claude Code row). Re-run it any time with
`mise run doctor`. `./equin start` and `build` also run it first, so a
missing tool is reported before any long step rather than minutes into one.

Don't install Bun or Go another way (Homebrew included): a copy outside mise
bypasses `mise.lock`, and the build's `toolchain:resolved` check rejects a
release other than the locked one.

**Do not run as root.** Postgres' `initdb` refuses to run as the root OS user, so the embedded cluster — and therefore every backend behind it — cannot start. `./equin start` and a released bundle's `launch` both refuse outright rather than fail downstream. This bites on fresh servers in particular: the deploy plugin defaults `sshUser` to `root`, so create a non-root user and run as them (`adduser --disabled-password --gecos '' equin`, `chown -R` the install dir, then `su - equin`).

Postgres needs no install. `bun install` brings the server (`embedded-postgres` ships `postgres` / `initdb` / `pg_ctl`) and the client tools the app uses to fork and back up databases (`pg_dump` / `pg_restore`, from [`client-tools`](../plugins/database/plugins/client-tools/CLAUDE.md)). Both come from the same Postgres release.

The app is then at <http://equin.localhost:9000>. `start` is a one-time,
system-level step. On macOS it registers the gateway with launchd
(`~/Library/LaunchAgents/<gateway-label>.plist`), so it comes back on
its own at every login — after a reboot too — and is relaunched if it crashes;
the gateway then brings Postgres and the app back up. `./equin stop` stops
it until the next login, and `./equin stop --disable` also stops it
starting at login. On Linux it is a systemd user unit
(`~/.config/systemd/user/<gateway-label>.service`) that starts at boot,
nobody logged in — it needs lingering (`sudo loginctl enable-linger $USER`,
which `install.sh` enables). The gateway listens on loopback only
(`127.0.0.1` and `::1`); `EQUIN_LISTEN=:9000 ./equin start` opens it on
every interface. Elsewhere (no launchd, no systemd)
the gateway does not survive a reboot: run `./equin start` again after one.

(`<gateway-label>` is the gateway's launchd label / systemd unit name, `dev.equin.gateway` (`GATEWAY_SERVICE` in `infra/launcher/core`; an install from before the rename keeps `LEGACY_IDS.launchdLabel` until it migrates, below).)

**An install from before the rename** keeps its data in the legacy home dir
(`LEGACY_IDS.dataDirName`) and its gateway under the old label: everything
keeps working on them, and a fresh install gets `~/.equin` and
`dev.equin.gateway`. To move over, run `./equin data-dir migrate` from your
checkout (a dry run that prints the plan), then `./equin data-dir migrate --apply`
while no build, push, test or agent is running. It stops the app, moves the
data dir to `~/.equin` (and `~/.backups/<legacy>` to `~/.backups/equin`),
rewrites every stored copy of the old path (every database, the files under
the dir, Claude Code's transcript dirs), drops the cache entries that hold
one (they are rebuilt on demand, so the next `start` takes a few minutes),
removes the old dir once a scan finds nothing left, relabels the gateway and
starts the app again.

**Chromium is not part of the install.** It is an on-demand dependency
([`infra/deps`](../plugins/infra/plugins/deps/CLAUDE.md)), installed (~600 MB)
the first time something needs it: the full check pass (its layout-geometry
suite, so a build without `--skip-checks` or a `push`), an `e2e/` script, or an
agent's `browser_*` tools. The install's build passes `--skip-checks` because
main's tree already passed every check when it was pushed. On Linux, headless
Chromium links against system libraries a server image lacks (NSS, ATK,
libgbm, ALSA, …); its install then fails, naming the missing libraries and the
one root command that installs them (Playwright's own `install-deps chromium`).

## Postgres

equin ships an embedded Postgres 18 cluster, supervised by the gateway — see [`plugins/database/`](../plugins/database/CLAUDE.md). Binaries come from `@embedded-postgres/<platform>` (installed via `bun install`); `initdb` runs on first start, the cluster lives in `~/.equin/postgres/data-pg18/`, and `postgres` listens on a Unix socket at `~/.equin/postgres/socket` on port `5433`.

The base database (`LEGACY_IDS.pgBaseDatabase`) is created by the script that starts the cluster — empty, on every start, so you never create it yourself and a deleted one comes back. The first backend to boot against it applies the migrations.

Each conversation (worktree) gets its own database inside the same cluster, forked from the base database at conversation-creation time via `pg_dump | pg_restore`. The default user (`LEGACY_IDS.pgUser`) has peer/trust auth on the Unix socket — no password to manage.

### Using system PG instead of embedded

Edit `~/.equin/state/db-config/database.json` (auto-generated on first `./equin start`):

```json
{
  "connection": {
    "host": "localhost",
    "port": 5432,
    "user": "your-username"
  },
  "services": []
}
```

An empty `services` array disables the gateway's embedded-PG supervisor. The `connection` block tells the server and CLI how to reach your system PG. Then restart the gateway with `./equin start --force`.

In this mode the cluster is yours, not the app's, so nothing provisions inside it: you install and run a Postgres 18 server yourself and create the base database (`LEGACY_IDS.pgBaseDatabase`) (on macOS, for example, `brew install postgresql@18 && brew services start postgresql@18 && createdb <base database>`). The app still forks and backs up with its own bundled client tools, which are Postgres 18.

## Git hooks

`mise install` sets them (its `setup` task runs `git config core.hooksPath .githooks`). `core.hooksPath` lives in `.git/config` (not tracked), so it cannot be committed, and one setting covers every worktree of the clone. The `.githooks/prepare-commit-msg` hook auto-stamps commits made inside a Claude pane with a conversation trailer, so the server can attribute commits to the conversation that authored them.

## If you cloned someone else's repo

Nothing extra to configure. The first `./equin push` asks the remote whether this checkout may write to it (a dry-run push, which writes nothing) and records the answer in `.git/config` beside `core.hooksPath`. With no write access, push commits, rebases, runs the checks and fast-forwards your **local** `main` — which is what main's auto-build watches — and pushes nothing. It also stops fetching the other repo's `main` into yours, which would otherwise pull in changes you never reviewed and eventually break push outright.

The repo you cloned from is then your **upstream**: a daily check records a report when it has new commits, and you update on your own terms with `./equin upstream status` and `./equin upstream merge` in a worktree. If you fork instead, point `origin` at your fork; push publishes there, and `upstream` is added for you.
