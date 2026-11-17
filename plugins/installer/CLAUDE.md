# installer

The equin installer: `install.sh` (repo root — its URL is the documented
entry point) emits ONE structured event stream, and renderers draw it. Design:
[`research/2026-11-17-global-installer-window.md`](../../research/2026-11-17-global-installer-window.md).

## The event stream (protocol v1)

- **One schema**, `core/` (`InstallEvent`, a zod discriminated union): NDJSON,
  one event per line, each with `v: 1`, `t` (ISO-8601 UTC) and `type`:
  `plan` (groups, then every step with `label`, `doing`, `group`, `est_s` —
  the build with its `substeps`), `step` (`start | done | skipped | failed`,
  `ms`), `progress` (`done` / `total` in `crates | plugins | packages | %`),
  `wait` (`start | end`, what on, who holds it), `log` (a step's output, or
  the script's own with `step: null`), `done` (`url`) and `exit` (`code`,
  always the last line).
- **Step ids are a closed set** (`InstallStepId`: tools, mise, clone,
  toolchain, start, build, and the build's sub-steps `build.database`,
  `build.deps`, `build.codegen`, `build.interface`, `build.deploy`).
- **Estimates are measured, never guessed**: `est_s` comes from install.sh's
  generated `estimates` block (`./equin installer estimates`, from
  `core/estimates.json`); null means no number is shown for that step.
- **Messages live in the events**: labels and text come from the step engine,
  never from a renderer — the installer message rules
  (`infra/launcher/installer-notice`) are applied in one place.

## install.sh: the hub and the run dir

- **Every run has a dir**, `~/.equin/logs/install/<run-id>/` (`latest` links
  to the newest): `events.fifo` while it runs, `events.jsonl` (every event, the
  install's record) and, after a success, `timing.json` (`InstallTiming`: each
  step that ran to done, with its `ms`; `dryRun: true` from `--dry-run`).
- **One hub**: a background `tee` reads the FIFO, appends to `events.jsonl`
  and hands each line on — to the window's `--events-fd`, else to the terminal
  view. install.sh keeps one write end open for its whole life (`ev`); the
  `./equin` commands it runs as steps open the FIFO **by path** from
  `EQUIN_INSTALL_EVENTS`, filing what they report (the build's sub-steps,
  counts, waits) under `EQUIN_INSTALL_STEP` — both exported into the step's
  subshell only. A step's commands inherit no fd of the stream, so a daemon
  never holds it open.
- **Every event is one write under PIPE_BUF** (512 bytes): concurrent writers
  never interleave. A log line too long for that is cut in the event
  (`log_line`); only the plan, written before any other writer exists, is
  longer.
- **Exit drains**: the EXIT trap writes `exit`, closes the write end and waits
  for the hub, then writes `timing.json`, and only then prints a failure's
  message (below the terminal view's last frame). The hub ignores INT / TERM /
  HUP; the script traps them (`exit 130 / 143 / 129`) so `exit` says so.
- **Progress from tools that redraw with CR** (`git clone --progress`,
  `softwareupdate --verbose`): `ev_frames` reads a character at a time, turns
  the percentage into `progress` when it changes, and keeps only each phase's
  last frame as a log line.
- **`run_step` is never a condition.** It always returns 0 and leaves the
  step's status in `STEP_RC` (`run_step x cmd; [ "$STEP_RC" = 0 ] || fail …`).
  Called as `run_step … || fail` or `if run_step …`, bash would ignore `set -e`
  for everything it runs — the step's subshell too, though it sets `-e` again —
  so a command failing mid-body (apt-get, then a line that passes) would read
  as a done step. The dry run fails its step mid-body, so the stream test
  catches a regression.
- **A step's stderr is merged into its stdout** (`2>&1` into one line reader),
  so every step `log` line says `stream: out`; only the script's own stderr,
  read by the window, is `err`.
- **Bash 3.2** (what every Mac ships): no associative arrays, no `${x,,}`,
  `read -t` in whole seconds (a timeout and EOF both return 1: a timeout
  leaves the variable as it was). Write `${a}━`, never `$a━`: 3.2 reads a
  non-ASCII byte after `$name` as part of the name.

## install.sh: the terminal view

Without a window the hub draws the stream itself (`render`), from the events
and the plan's arrays (`plan_data`):

- **interactive** (stdout a terminal, `TERM` not dumb, no `CI`): a status
  block redrawn in place (on every step change, else once a second) — one row
  per group, the build's sub-steps with their counts while it runs, the
  overall bar, elapsed, time left, the last two log lines and the log path;
  the done screen after. A password prompt (`wait … password`) stops the
  redraws until it is answered.
- **plain** (CI, a pipe): append-only `HH:MM:SS [n/N] <step>: …` lines —
  started (usually …), every 25 %, waits, done in …, `equin is ready · …`.
  A failed step prints its last lines (`  > `).
- **Time left** = Σ pending `est × pace` + the running one's `max(0, est ×
  pace − worked)`, waits not counted; pace = worked / estimated over the
  finished steps that had one. Any step left without an estimate → no time
  at all ("step n of N"). The same math and wait wording as the window's page
  (`window/standalone-page/model.ts`).

## The dry run

`install.sh --dry-run` touches nothing but its own run dir. It emits every
event type: a skipped step, output that needs escaping (and a line too long
for one event), git's CR progress, counted progress (`start`, the build's
sub-steps), a wait with its holder, and the build's sub-steps written through
the FIFO by path, as `./equin build` does. `EQUIN_INSTALL_DRY_RUN_FAIL=<step>`
fails that step's first attempt; `EQUIN_INSTALL_DRY_RUN_PACE=<s>` slows it down
for watching a renderer. Held to the schema by
`window/cli/internal/dry-run-stream.test.ts` (window mode, events.jsonl,
timing.json, the plain view), run under `/bin/bash` with `HOME` a temp dir.

## Stage 0: which equin, and which view (`install.sh`, top)

`curl …/main/install.sh | bash` runs main's script, whose first job is to
hand over to the release it installs (`stage0`):

1. **Resolve**: `releases/latest/download/release.json` (a redirect, not the
   REST API: no rate limit), or `download/<tag>/…` for `--ref <tag>`.
2. **Download** into `~/.equin/install/bin/<tag>/` — `SHA256SUMS`,
   `release.json`, the tag's `install.sh`, and this platform's window binary
   unless `--terminal` — all from that one tag.
3. **Verify** each against `SHA256SUMS` (`shasum -a 256 -c`, else GNU
   `sha256sum -c`: macOS's `/sbin/sha256sum` is BSD's and reads no list).
   A mismatch or a missing entry stops the install; the file is deleted,
   never run.
4. **Pick the view** (`choose_view`): the window unless `--terminal`, no
   binary for this system, Linux without a display, SSH, `CI`, output not a
   TTY, or a sandboxed shell (`CLAUDECODE`, `APP_SANDBOX_CONTAINER_ID`) —
   then the binary's own `--probe` (a hidden window loading the page; a
   missing webkit2gtk fails before `main`). `--window` skips the guesses, not
   the probe, and stops loudly when it fails.
5. **Exec** `equin-installer --script <install.sh@tag> -- --release <tag>
   --checkout <ref> <install args>`, or `bash <install.sh@tag> --release …`.

`--release` marks the script as a release's (stage 0 never runs twice);
`--checkout` is what the clone checks out: the tag (`git checkout -B main
<tag>`, still tracking `origin/main`, so updates move it release to release),
or `main` for `--ref main` and for a fork (`--repo`). **Falls back to this
script's own steps, in the terminal, saying why** when no release could be
read (none published, no network: main's tip), or the release predates the
hand-off (`release.json` `handoff: null`: its tag). Run from a checkout
(`./install.sh`), stage 0 is skipped and that checkout is installed.
`--stage0-only` prints the decision instead (the stage-0 test,
`release-assets/core/internal/stage0.test.ts`, against a local fake release
server via `EQUIN_RELEASES_URL`). Release side:
[`release-assets`](plugins/release-assets/CLAUDE.md).

## Decisions (fd 4)

With `--control-fd`, a failed step waits for one line: `retry` runs it again
(every step checks before it acts), `quit` returns its status to the caller,
which explains the failure and exits 1. EOF (the window closed) is `quit`; an
unknown line is ignored with a stderr note.

## `./equin` as an install step (`cli/`, `bin/`)

- **`emitInstallEvent`** (`cli` barrel) writes one typed event to the FIFO in
  `EQUIN_INSTALL_EVENTS`, opened by path, close-on-exec, non-blocking (a hub
  that is gone fails the open loudly) and written whole under 512 bytes. Outside
  an install every function is a no-op.
- **The build's sub-steps** are declared by its profiler spans:
  `buildProfilerStart(id, phase, label, { installStep: "build.codegen" })`
  (op-runtime's `SpanOptions`). Entering a span starts its sub-step and ends
  the one before; one the build jumped over is `skipped`; a span of an earlier
  sub-step leaves the view where it is (it only moves forward); the build's
  verdict ends the last (`finishBuildSubSteps`). The
  `installer:build-sub-steps-declared` check fails when no span declares one.
- **Progress**: cargo's crates (the deps `rust` kind forces cargo's own bar and
  reads it from the install log as it grows, `EnsureOptions.progress`, passed by
  `./equin start`), the artifact builder's plugins (`onArtifactBuilt`), bun's
  packages (`ensureDeps` pipes `bun install --verbose` through
  `bin/bun-install-progress.ts`, which counts `Extracted` lines against
  `bun.lock` and passes the rest through), git's and softwareupdate's
  percentages (install.sh). Rate-bound to one event per 250 ms per step.
- **Waits**: the build's op profiler (`withInstallWaits`, build's
  `cli/internal/install-waits.ts`) reports the build lock, the duress gate and
  the host CPU grant as `wait` events, the grant with the op holding it (the
  oldest admitted op in the op log).

## Estimates (`core/estimates.json`)

`./equin installer estimates [--from <dir…>]` takes each step's median over
every real install's `timing.json` (this machine's run dirs, plus timing files
collected elsewhere; dry runs never count) and writes `core/estimates.json`
and install.sh's generated `estimates` block (`--from-json` rewrites only the
block). `installer:estimates-in-sync` holds the two equal. Until a clean
install is measured every value is null, and no renderer shows a time.

## Sub-plugins

- `window` — the native installer window (`equin-installer`).
- `release-assets` — what a release tag publishes (the GitHub Actions
  workflow, `release.json`, `SHA256SUMS`) and its checks.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The equin installer: install.sh's structured event stream (protocol v1 — plan, step, log, done and exit events, one zod schema in core) and the renderers that draw it. Its window sub-plugin is the native installer window.
- Cross-plugin:
  - Imported by:
    - `framework/cli/bootstrap`
    - `framework/cli/build`
    - `framework/cli/op-runtime`
    - `framework/cli/start`
    - `installer/release-assets`
    - `installer/window`
- Core:
  - Exports (types): `InstallEventBody`
  - Exports (values):
    - `BUILD_SUB_STEP_IDS`
    - `BuildSubStepId`
    - `ESTIMATES_BEGIN`
    - `ESTIMATES_END`
    - `estimatesFrom`
    - `findEstimatesBlock`
    - `INSTALL_ESTIMATES`
    - `INSTALL_PROTOCOL_VERSION`
    - `INSTALL_STEP_IDS`
    - `InstallEstimates`
    - `InstallEvent`
    - `InstallGroupId`
    - `InstallMode`
    - `InstallStepId`
    - `InstallTiming`
    - `InstallTopStepId`
    - `parseInstallEventLine`
    - `PlanGroup`
    - `PlanStep`
    - `PlanSubStep`
    - `ProgressUnit`
    - `renderEstimatesBlock`
    - `WaitHolder`
    - `WaitOn`
- Cli:
  - Exports (values):
    - `emitInstallEvent`
    - `enterBuildSubStep`
    - `finishBuildSubSteps`
    - `installEventsOn`
    - `reportInstallProgress`
    - `reportInstallWait`
- Sub-plugins:
  - **`release-assets`** — What a release tag publishes for the curl install: the GitHub Actions workflow (.github/workflows/installer-release.yml) that builds the installer window per release tag, the asset names and…
  - **`window`** — The installer window: equin-installer, a small wry/tao Rust app (rust/) that runs install.sh as its child — events on fd 3, decisions on fd 4 — and draws the stream in a page bundled into the binary…

<!-- AUTOGENERATED:END -->
