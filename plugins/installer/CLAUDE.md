# installer

The equin installer: `install.sh` (repo root — its URL is the documented
entry point) emits ONE structured event stream, and renderers draw it. Design:
[`research/2026-11-17-global-installer-window.md`](../../research/2026-11-17-global-installer-window.md).
User-facing summary: [`docs/setup.md`](../../docs/setup.md) § Quick install.

## Running it

```sh
curl -fsSL https://raw.githubusercontent.com/equinai/equin/main/install.sh | bash          # newest release
curl -fsSL …/install.sh | bash -s -- --terminal --ref main                                   # piped: options after `bash -s --`
./install.sh                                                                                 # from a clone: installs THAT checkout
```

| Flag | What it does |
| --- | --- |
| `--dir <path>` | Where the clone goes (default `~/equin`). |
| `--repo <url>` | Clone a fork; checks out its `main` (forks have no releases). |
| `--no-shell-rc` | Don't add mise's activation to the shell's rc file. |
| `--ref <tag\|main>` | Install that release tag, or `main`'s tip; default the newest release. |
| `--terminal` | Draw the install in the terminal; no window is downloaded. |
| `--window` | Open the window even where stage 0 would guess terminal (SSH, `CI`, no TTY…); still probed, and stops loudly when the probe fails. |
| `--dry-run` | Emit every event type, touching nothing but its run dir (§ The dry run). |
| `--fix [--yes]` | Start Claude Code on the problem the last install stopped on (`--yes`: without asking before each command). |
| `--report` | Print (and open) the GitHub issue link for that problem. |

Internal (passed between the install's own processes, never typed):
`--release`, `--checkout` (stage 0 → the release's script), `--events-fd`,
`--control-fd` (the window → its child), `--stage0-only` (the stage-0 test).

**The views.** The window (`equin-installer`, [`window`](plugins/window/CLAUDE.md))
by default on a desktop; the **interactive terminal** view (a redrawn status
block) over SSH, with `--terminal`, or where no window can open; the **plain**
view (append-only lines) under `CI` or into a pipe. All three draw the same
stream, so they say the same words. Which one, and why: § Stage 0, step 4.

## The five message rules

Every installer message — whatever stops the install, asks for a permission,
pauses it or leaves something out — keeps the user's five rules (decided
2026-11-17; owner and enforcement:
[`infra/launcher/installer-notice`](../infra/plugins/launcher/plugins/installer-notice/CLAUDE.md)):

1. **No internal names** (gateway, menu-bar helper, crate, TCC, sandbox,
   build slot, launchd, PID, bundle…): say what the user gets — "an icon in
   your menu bar", "equin's own database".
2. **Say what equin was trying to do, and why it helps the user.**
3. **Say why it was blocked, in the user's terms.**
4. **Say what the user can do now, and what happens if they skip or say no**
   — optional or not, what still works, how to add it later.
5. **Raw technical lines** (error output, permission ids, paths, labels,
   PIDs) **go in the log or the evidence area, never in the message.**

Where they are held: in TypeScript, `InstallerNotice` (one field per rule)
built through `defineNotice`, which refuses an internal name, a path or a
label; in `install.sh`, the split is the signature — `fail <message>
<details>`, `pause <step> <kind> <title> <text> <optional> <manual> <evidence…>`
(evidence is its own argument list, the `pause` event's `evidence`), and the
plan's `label` / `doing` per step. A renderer never writes a message of its
own (next section): fix wording in the step engine, and every view changes.

## The event stream (protocol v1)

- **One schema**, `core/` (`InstallEvent`, a zod discriminated union): NDJSON,
  one event per line, each with `v: 1`, `t` (ISO-8601 UTC) and `type`:
  `plan` (groups, then every step with `label`, `doing`, `group`, `est_s` —
  the build with its `substeps`), `step` (`start | done | skipped | failed`,
  `ms`), `progress` (`done` / `total` in `crates | plugins | packages | %`),
  `wait` (`start | end`, what on, who holds it), `log` (a step's output, or
  the script's own with `step: null`), `pause` (a diagnosis: kind, title,
  text, evidence, blocking, optional, manual), `resolved` (how a pause
  ended), `fixing` (Fix with Claude opened: where), `notice` (a part left
  out, and where it stands), `done` (`url`) and `exit` (`code`, always the
  last line).
- **Step ids are a closed set** (`InstallStepId`: tools, mise, clone,
  toolchain, start, build, and the build's sub-steps `build.database`,
  `build.deps`, `build.codegen`, `build.interface`, `build.deploy`).
- **Estimates are measured, never guessed**: `est_s` comes from install.sh's
  generated `estimates` block (`./equin installer estimates`, from
  `core/estimates.json`); null means no number is shown for that step.
- **Messages live in the events**: labels and text come from the step engine,
  never from a renderer — the installer message rules
  (`infra/launcher/installer-notice`) are applied in one place.
- **Transport**: install.sh writes every event to its run dir's FIFO; a hub
  appends it to `events.jsonl` and hands it on to the window (`--events-fd`,
  the child's fd 3) or to the terminal view (§ install.sh: the hub).
  `parseInstallEventLine` reads one line (`{ok, event}` / `{ok:false,
  error}`); a renderer treats a line outside the schema as a loud protocol
  error, never skips it.
- **Decisions go the other way, as words**, one per line on `control.fifo`
  (the window's fd 4 forwarded there, a key in the interactive terminal, or
  Claude's `resume`): `retry`, `skip` (only when the pause says `optional`),
  `quit` (`eof` = the window closed); `fix-app` / `fix-cli` / `show-claude`
  are carried out by the forwarder itself. The window's full command set is
  in [`window`](plugins/window/CLAUDE.md) § the page.
- **Versioning**: `v` is the protocol's major version
  (`INSTALL_PROTOCOL_VERSION`); a renderer refuses any other. Every event is
  a `strictObject`, so even a new field breaks an older reader — which is
  safe only because a release's window binary reads that release's own
  `install.sh` and `./equin` (stage 0 fetches both from one tag). Bump `v`
  when that stops holding (a window reading another release's stream).
- **Changing the stream**: edit `core/internal/events.ts`, the bash emitter
  (`ev` / `ev_*` in install.sh — hand-written JSON, escaped by `json_str`),
  the dry run (it must emit every type), and the renderers (the window's
  `model.ts`, install.sh's `render`). The dry-run stream test fails until the
  bash side matches the schema.

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
   binary for this system, Linux without a display or a session D-Bus
   (WebKitGTK stalls ~30 s without one), SSH, `CI`, output not a
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

## Failures: diagnosis, pause, decisions

A failed step is never a bare error. `run_step` diagnoses it, pauses it (a
`pause` event) and waits for a decision; every message follows the five
installer message rules (`infra/launcher/installer-notice`): no internal
names, what equin was doing and why, why it was blocked, what to do now and
what skipping costs — raw lines only in `evidence` and the log.

- **Diagnosis rules** (`diagnose`, install.sh): each is a symptom AND a fact
  checked on the machine; one alone is never enough.
  - **sandbox** — killed outright (exit 137 / SIGKILL in its last lines) AND
    this shell is protected: on macOS a sandboxed process may not run a setuid
    program, so `/bin/ps` is refused (`sandbox-exec` execs what it protects:
    there is NO sandbox-exec parent to find); an App Sandbox container; a
    bubblewrap / firejail parent on Linux. The same fact is checked **before
    any step** (`sandbox_check`, with Claude Code's refused-write probe): a
    refused write can't be skipped, a protected shell may allow the install
    (Skip tries anyway). Manual: Continue in Terminal.
  - **security** — a path under equin's folders "No such file or directory" /
    "Operation not permitted" in the last lines AND an endpoint-security
    product running (`security_agent`: Jamf Protect, CrowdStrike Falcon,
    SentinelOne, Microsoft Defender, Sophos, WithSecure — by process name; a
    Mac's MDM enrollment). Names the product. Manual: Copy request for IT.
  - **stall** — never stops the step (`blocking: false`, ended by `resolved
    progress`). The **watchdog** (`ev_lines`): no output for STALL_S
    (10 min, or 3 × the step's median) and events.jsonl as old, no wait open.
    The **build slot** (build's `install-waits.ts`, `judgeHolder`): waited past
    2 min AND the holder (the op log's oldest working op) showed no progress
    for 10 min — a deadline re-armed only when the holder moved.
  - **unknown** — anything else: "<doing> didn't finish", the step's last 20
    lines; it never guesses. Tools on macOS in the window: "Apple's developer
    tools weren't installed" (Try again opens Apple's dialog again).
- **The run dir after a pause**: `diagnosis.json`, `fix-prompt.md` (the
  problem, system, the log's last 150 lines, the rules: explain first, ask
  before each command, never touch security software, run the resume command
  once fixed), `fix.command` (Claude Code started with it — installed first
  with Anthropic's installer when missing), `report-url`, and `install.log`
  (every log line, whole). `~/.equin/logs/install/resume` (a dry run: its run
  dir's) writes `retry` to the waiting install, else runs the install again.
- **Decisions arrive on ONE FIFO** (`control.fifo`, held read-write by the
  script so a writer by path never blocks): bash waits on one fd, and the
  decisions have several sources — the window's fd 4 (a forwarder process,
  which also carries out Fix with Claude / Show Claude itself, so a stall's
  Fix works while the step still runs), a key in the interactive terminal
  (`start_keys`), and Claude's `resume`. `retry` runs the step again, `skip`
  only when the pause says `optional`, `quit` (or `eof`: the window closed)
  stops with exit 1 — the pause already said everything, so no second message.
- **Per view**: the window draws the pause (`installer/window`); the
  interactive terminal draws the block's last frame, the box and a menu
  (`[t]` Try again, `[f]` Fix with Claude — Claude Code in this terminal,
  `[m]` the manual action, `[s]` Skip, `[r]` Report, `[l]` the log, `[q]`
  Quit); plain mode prints the box and the next commands and exits 1.
- **Fix with Claude**: the Claude app — the prompt on the clipboard (`pbcopy`,
  `wl-copy`, `xclip`, `xsel`), then the app (claude.ai in the browser on
  Linux): it has no supported prefilled-prompt link. Claude Code in Terminal —
  `open fix.command` (no Automation permission), a terminal emulator on
  Linux. `--fix` / `--report` act on the last stopped install (`--fix --yes`
  without a terminal: Claude Code acting without asking).
- **Report issue**: the window builds it with `installIssueUrl` (core:
  `buildIssueUrl` + `redactPaths`), the terminal with `report_url` (bash, the
  same fields); evidence is written with `$HOME` as `~` and the account and
  machine names removed. Nothing is sent until the person submits it.
- **A part left out** (`notice`): `./equin start` reports the login services
  macOS refused (App Management). The install goes on: a banner while it
  runs (Open App Management, Skip), "Installed without … Add it now" on the
  done screen — the script waits after `done` (window only): Add it now opens
  the setting, then runs `./equin start --only <ids>`; closing the window is
  `quit`, exit 0.
- **First-time macOS setup in the window**: Apple's own dialog
  (`xcode-select --install`, waited out every 5 s — an OS dialog has no
  change signal), never `sudo softwareupdate`. **Linux in the window**: `sudo
  -A` with an askpass wrapper running the window's binary (`--askpass`), which
  asks the window over its socket for a password sheet.
- **Reproducing each on purpose** (dry run): `EQUIN_INSTALL_DRY_RUN_FAIL=
  <step>[:sigkill|:vanish|:quiet]` — sigkill under `sandbox-exec -p '(version
  1)(allow default)'` is the sandbox rule, vanish (a program deleted right
  after it was made) with a process named `JamfProtect` running is the
  security rule (`cc` a sleeping C program named so), quiet with
  `EQUIN_INSTALL_STALL_S=1` the watchdog; `EQUIN_INSTALL_DRY_RUN_OPTIONAL=
  <step>` offers Skip, `EQUIN_INSTALL_DRY_RUN_NOTICE=1` the part left out.
  The stream test runs all but security (it needs the fake product).

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
- Core:
  - Uses:
    - `framework/product-name.SOURCE_REPO_URL`
    - `integrations/github-issues.buildIssueUrl`
  - Exports (types):
    - `InstallEventBody`
    - `InstallReport`
  - Exports (values):
    - `BUILD_SUB_STEP_IDS`
    - `BuildSubStepId`
    - `ESTIMATES_BEGIN`
    - `ESTIMATES_END`
    - `estimatesFrom`
    - `findEstimatesBlock`
    - `FixTarget`
    - `INSTALL_ESTIMATES`
    - `INSTALL_PROTOCOL_VERSION`
    - `INSTALL_STEP_IDS`
    - `InstallEstimates`
    - `InstallEvent`
    - `InstallGroupId`
    - `installIssueUrl`
    - `InstallMode`
    - `InstallStepId`
    - `InstallTiming`
    - `InstallTopStepId`
    - `NoticeState`
    - `parseInstallEventLine`
    - `PauseKind`
    - `PauseManualId`
    - `PauseResolution`
    - `PlanGroup`
    - `PlanStep`
    - `PlanSubStep`
    - `ProgressUnit`
    - `redactPaths`
    - `renderEstimatesBlock`
    - `WaitHolder`
    - `WaitOn`
- Cross-plugin:
  - Imported by:
    - `framework/cli/bootstrap`
    - `framework/cli/build`
    - `framework/cli/op-runtime`
    - `framework/cli/start`
    - `installer/release-assets`
    - `installer/window`
- Exemptions:
  - Exempts itself from: `paths:no-hardcoded-paths` — `core/internal/report.test.ts` (sanctioned)
- Cli:
  - Exports (values):
    - `emitInstallEvent`
    - `enterBuildSubStep`
    - `finishBuildSubSteps`
    - `installEventsOn`
    - `reportInstallNotice`
    - `reportInstallProgress`
    - `reportInstallResolved`
    - `reportInstallStall`
    - `reportInstallWait`
- Sub-plugins:
  - **`release-assets`** — What a release tag publishes for the curl install: the GitHub Actions workflow (.github/workflows/installer-release.yml) that builds the installer window per release tag, the asset names and…
  - **`window`** — The installer window: equin-installer, a small wry/tao Rust app (rust/) that runs install.sh as its child — events on fd 3, decisions on fd 4 — and draws the stream in a page bundled into the binary…

<!-- AUTOGENERATED:END -->
