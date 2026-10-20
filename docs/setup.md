# Setup

One-time environment setup for developing Singularity.

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/Conchylicultor/singularity/main/install.sh | bash
```

Or `./install.sh` from inside a clone or fork you already have. Options:
`--dir <path>` (default `~/singularity`), `--repo <url>` (your fork),
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
git clone <repo url> singularity && cd singularity
mise trust && mise install   # trust this checkout's mise.toml, then install

# 5. The app.
./singularity start               # compiles and starts the gateway, and brings up Postgres
./singularity build --allow-main --skip-checks  # builds the app and deploys it
```

`mise install` also runs the repo's `setup` task (trusts every worktree's
`mise.toml`, points git at the repo's hooks) and ends with the **doctor**, which
names every missing prerequisite at once, each with the command that fixes it.
Continue only once it says `all required present`. Claude Code is the one
*recommended* item: the doctor names it with its fix but does not stop on it,
since the app builds and runs without it — only agents need it, and the app
says so where they are launched (the health report's Claude Code row). Re-run it any time with
`mise run doctor`. `./singularity start` and `build` also run it first, so a
missing tool is reported before any long step rather than minutes into one.

Don't install Bun or Go another way (Homebrew included): a copy outside mise
bypasses `mise.lock`, and the build's `toolchain:resolved` check rejects a
release other than the locked one.

**Do not run as root.** Postgres' `initdb` refuses to run as the root OS user, so the embedded cluster — and therefore every backend behind it — cannot start. `./singularity start` and a released bundle's `launch` both refuse outright rather than fail downstream. This bites on fresh servers in particular: the deploy plugin defaults `sshUser` to `root`, so create a non-root user and run as them (`adduser --disabled-password --gecos '' singularity`, `chown -R` the install dir, then `su - singularity`).

Postgres needs no install. `bun install` brings the server (`embedded-postgres` ships `postgres` / `initdb` / `pg_ctl`) and the client tools the app uses to fork and back up databases (`pg_dump` / `pg_restore`, from [`client-tools`](../plugins/database/plugins/client-tools/CLAUDE.md)). Both come from the same Postgres release.

The app is then at <http://singularity.localhost:9000>. `start` is a one-time,
system-level step. On macOS it registers the gateway with launchd
(`~/Library/LaunchAgents/dev.singularity.gateway.plist`), so it comes back on
its own at every login — after a reboot too — and is relaunched if it crashes;
the gateway then brings Postgres and the app back up. `./singularity stop` stops
it until the next login, and `./singularity stop --disable` also stops it
starting at login. On Linux it is a systemd user unit
(`~/.config/systemd/user/dev.singularity.gateway.service`) that starts at boot,
nobody logged in — it needs lingering (`sudo loginctl enable-linger $USER`,
which `install.sh` enables). On a server, `SINGULARITY_LISTEN=127.0.0.1:9000
./singularity start` keeps it on loopback. Elsewhere (no launchd, no systemd)
the gateway does not survive a reboot: run `./singularity start` again after one.

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

Singularity ships an embedded Postgres 18 cluster, supervised by the gateway — see [`plugins/database/`](../plugins/database/CLAUDE.md). Binaries come from `@embedded-postgres/<platform>` (installed via `bun install`); `initdb` runs on first start, the cluster lives in `~/.singularity/postgres/data-pg18/`, and `postgres` listens on a Unix socket at `~/.singularity/postgres/socket` on port `5433`.

The base database is called `singularity`, and the script that starts the cluster creates it — empty, on every start, so you never create it yourself and a deleted one comes back. The first backend to boot against it applies the migrations.

Each conversation (worktree) gets its own database inside the same cluster, forked from `singularity` at conversation-creation time via `pg_dump | pg_restore`. The default user is `singularity` with peer/trust auth on the Unix socket — no password to manage.

### Using system PG instead of embedded

Edit `~/.singularity/state/db-config/database.json` (auto-generated on first `./singularity start`):

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

An empty `services` array disables the gateway's embedded-PG supervisor. The `connection` block tells the server and CLI how to reach your system PG. Then restart the gateway with `./singularity start --force`.

In this mode the cluster is yours, not the app's, so nothing provisions inside it: you install and run a Postgres 18 server yourself and create the `singularity` database (on macOS, for example, `brew install postgresql@18 && brew services start postgresql@18 && createdb singularity`). The app still forks and backs up with its own bundled client tools, which are Postgres 18.

## Git hooks

`mise install` sets them (its `setup` task runs `git config core.hooksPath .githooks`). `core.hooksPath` lives in `.git/config` (not tracked), so it cannot be committed, and one setting covers every worktree of the clone. The `.githooks/prepare-commit-msg` hook auto-stamps commits made inside a Claude pane with a `Singularity-Conversation` trailer, so the server can attribute commits to the conversation that authored them.

## If you cloned someone else's repo

Nothing extra to configure. The first `./singularity push` asks the remote whether this checkout may write to it (a dry-run push, which writes nothing) and records the answer in `.git/config` beside `core.hooksPath`. With no write access, push commits, rebases, runs the checks and fast-forwards your **local** `main` — which is what main's auto-build watches — and pushes nothing. It also stops fetching the other repo's `main` into yours, which would otherwise pull in changes you never reviewed and eventually break push outright.

The repo you cloned from is then your **upstream**: a daily check records a report when it has new commits, and you update on your own terms with `./singularity upstream status` and `./singularity upstream merge` in a worktree. If you fork instead, point `origin` at your fork; push publishes there, and `upstream` is added for you.
