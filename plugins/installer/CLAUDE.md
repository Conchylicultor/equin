# installer

The equin installer: `install.sh` (repo root — its URL is the documented
entry point) emits ONE structured event stream, and renderers draw it. Design:
[`research/2026-11-17-global-installer-window.md`](../../research/2026-11-17-global-installer-window.md).
User-facing summary: [`docs/setup.md`](../../docs/setup.md) § Quick install.

## Running it

```sh
curl -fsSL https://raw.githubusercontent.com/equinai/equin/main/install.sh | bash          # newest release
curl -fsSL …/install.sh | bash -s -- --window --ref main                                     # piped: options after `bash -s --`
./install.sh                                                                                 # from a clone: installs THAT checkout
```

| Flag | What it does |
| --- | --- |
| `--dir <path>` | Where the clone goes (default `~/equin`). |
| `--repo <url>` | Clone a fork; checks out its `main` (forks have no releases). |
| `--no-shell-rc` | Don't add mise's activation to the shell's rc file. |
| `--ref <tag\|main>` | Install that release tag, or `main`'s tip; default the newest release. |
| `--terminal` | Draw the install in the terminal; no window is downloaded. The default today (`DEFAULT_VIEW`, below). |
| `--window` | Download and open the window (also where stage 0's guesses would pick the terminal: SSH, `CI`, no TTY…); still probed, and stops loudly when the probe fails. |
| `--dry-run` | Emit every event type, touching nothing but its run dir (§ The dry run). |
| `--fix [--yes]` | Start Claude Code on the problem the last install stopped on (`--yes`: without asking before each command). |
| `--report` | Print (and open) the GitHub issue link for that problem. |

**The default view is ONE switch**: `DEFAULT_VIEW` near the top of
`install.sh` — `terminal` (today, decided 2026-11-18: the terminal by
default for now; stage 0 neither downloads nor verifies the window unless
`--window`) or `auto` (the window wherever it can show, § Stage 0, step 4).
Releases keep publishing the window binaries either way. Making the window
the default again is `DEFAULT_VIEW=auto` plus the places that describe the
default: this file (§ Running it, § The views, § Stage 0), `install.sh`'s
header, [`docs/setup.md`](../../docs/setup.md) § Quick install and the
website's install steps (`website/pages/download`'s `INSTALLER_STEPS`),
and [`release-assets`](plugins/release-assets/CLAUDE.md) § the attach step. The
stage-0 test runs both values.

Internal (passed between the install's own processes, never typed):
`--release`, `--checkout` (stage 0 → the release's script), `--events-fd`,
`--control-fd` (the window → its child), `--attach <run dir> --mode <view>`
(an install → the checkout's own script, § The checkout's own steps),
`--stage0-only` (the stage-0 test). `--release`, `--checkout`, `--attach`,
`--mode` and `--since` travel in `EQUIN_INSTALL_INTERNAL_ARGS` (one per
line, read and unset at the script's start) to a script carrying `#
installer-internal-args: env` (`internal_args`; an older one gets them on its
command line): a terminal shows the running command line in its title bar.
The interactive view also sets the title to "equin installer" and, when it
ends, clears it and restores the terminal's own (xterm title stack, where the
terminal keeps one).

**The views.** The **interactive terminal** view (a redrawn status block) by
default; the window (`equin-installer`, [`window`](plugins/window/CLAUDE.md))
with `--window` (under `DEFAULT_VIEW=auto`: by default on a desktop, the
terminal over SSH or where no window can open); the **plain** view
(append-only lines) under `CI` or into a pipe. All three draw the same
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

## The event stream (protocol v2)

- **One schema**, `core/` (`InstallEvent`, a zod discriminated union): NDJSON,
  one event per line, each with `v: 2`, `t` (ISO-8601 UTC) and `type`:
  `plan` (groups, then every step with `label`, `doing`, `group`, `est_s` —
  the build with its `substeps`), `step` (`start | done | skipped | failed`,
  `ms`), `progress` (`done` / `total` in `crates | plugins | packages | %`),
  `wait` (`start | end`, what on, who holds it), `doing` (what a step is
  doing now, when it names a phase of its own — install.sh's `say` inside a
  step: the plain view prints it as a line, the interactive view under the
  step's row, the window in its status line, each in place of the plan's
  `doing` and of a count reported before it), `log` (a step's output, or
  the script's own with `step: null`), `pause` (a diagnosis: kind, title,
  text, evidence, blocking, optional, manual), `resolved` (how a pause
  ended), `fixing` (Fix with Claude opened: where), `notice` (a part left
  out, and where it stands), `done` (`url`) and `exit` (`code`, always the
  last line; `cause` when the install did not end itself — its terminal view
  ended under it, or the stream lost its reader).
- **Step ids are a closed set** (`InstallStepId`: tools, mise, clone,
  toolchain, start, build, and the build's sub-steps `build.database`,
  `build.deps`, `build.codegen`, `build.interface`, `build.deploy`).
- **Estimates are measured, never guessed**: `est_s` comes from install.sh's
  generated `estimates` block (`./equin installer estimates`, from
  `core/estimates.json`), the set of the platform and view the install runs
  in (§ Estimates); null means no number is shown for that step.
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
  (`INSTALL_PROTOCOL_VERSION`); a renderer reads it and the older versions
  it is a superset of (v1: v2 only added `doing`, so recorded v1 runs still
  replay and still give estimates), and refuses any other. Every event is
  a `strictObject`, so even a new field breaks an older reader — which is
  safe only because a window reads only streams of its own protocol: a
  release's window runs that release's `install.sh`, which hands the steps
  after the clone only to a checkout carrying the same `# installer-attach:
  <v>` line (§ The checkout's own steps) — so under `--ref main` the window
  reads main's steps and `./equin`. Any change an older window can't read
  bumps `v` (and with it the attach marker: `ATTACH_MARKER` is derived
  from it, and `release-assets:asset-names` holds install.sh's spellings to it).
- **Changing the stream**: edit `core/internal/events.ts`, the bash emitter
  (`ev` / `ev_*` in install.sh — hand-written JSON, escaped by `json_str`),
  the dry run (it must emit every type), and the renderers (the window's
  `model.ts`, install.sh's `render`). The dry-run stream test fails until the
  bash side matches the schema.

## install.sh: the hub and the run dir

- **Every run has a dir**, `~/.equin/logs/install/<run-id>/` (`latest` links
  to the newest): `events.fifo` while it runs, `events.jsonl` (every event, the
  install's record) and, after a success, `timing.json` (`InstallTiming`: each
  step that ran to done, with its `ms` — a build sub-step skipped inside a
  finished build as 0; the plan's `release` and `mode`, which tie the times to
  what ran and to their estimate set; `dryRun: true` from `--dry-run`).
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
  HUP; the script traps them (`exit 130 / 143 / 129`) so `exit` says so, and
  PIPE (`exit 141`): a stream that lost its reader ends the install with a
  message and an `exit` event (written by path when the hub is gone), never
  silently.
- **A view that dies stops the install loudly.** The hub runs `render` in a
  subshell of its own; when it ends before drawing `exit`, `view_ended`
  prints the cause on stderr, leaves it in `view-ended` (the exit event's
  `cause`, the failure message), sends TERM to the install and to the attached
  one (`attached-pid`) — taken between commands, so a step command already
  running finishes first — and keeps draining the stream, so no writer dies
  of SIGPIPE.
- **`read -t` loops go through `read_tick`.** bash 3.2 answers a timeout with
  status 1 and the variable untouched; bash ≥ 4 (Linux, Homebrew's bash) with
  a status above 128 and the variable set to what came so far — often empty,
  which a loop trusting the variable read as EOF (the terminal view quit on
  the first quiet second). `read_tick` tells line / EOF / timeout apart under
  both; `render` and `ev_lines` use it.
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

## Tests run under every bash

install.sh's behaviour tests (the dry-run stream test, the stage-0 test) run
their whole suite once per bash `installShBashes()` (`deps/testing`) returns:
GNU bash **3.2.57** and **5.2.37** built from their pinned, sha256-checked GNU
tarballs (the `installer-test-bashes` dependency, `deps/`: built on first use,
~2 min each, then shared by every checkout), plus `/bin/bash` — what `curl … |
bash` runs on this machine. So a Mac (only 3.2 of its own) still tests bash 5,
and a Linux (only 5.x) still tests 3.2. A bash that cannot be installed, or
whose binary is not its pinned version, throws: nothing is ever skipped. A new
install.sh test file gets the same with `describe.each` over it.

What it caught on its first run, both bash ≥ 5 only: the terminal view quitting
on the first quiet second (74226cbf93's bug — reverting that fix fails two
tests under 5.2, none under 3.2), and a Stop (SIGINT) sent to a paused install
ignored until the next decision — bash 5 can miss a trapped signal that lands
as a blocking `read` starts, so `read_decision` reads a tick at a time.

## The checkout's own steps (`--attach`)

An install of ref X runs X's own steps on X's code. The running script — a
release's, or stage 0's own — runs only what needs nothing from equin's code
(tools, mise, the clone); then `hand_to_checkout` runs the CHECKOUT's
`install.sh --attach <run dir> --mode <view>` for the rest (toolchain, start,
build, done) and exits with its status. So `--ref main` (and a fork) runs
main's steps even though an older release's script and window started it,
and no step needs a compatibility shim for an older script.

- **The owner keeps the stream**: the hub, the window's fds, the decision
  forwarder, `pid` (so `resume` and the window's Stop — a signal to the
  process group — reach both). The attached script opens its own write end of
  `events.fifo`, `control.fifo` and `install.log` by path (`attach_streams`),
  emits no `plan` and no `exit`, and rewrites `resume` to run from the
  checkout. It reports back through the run dir: `attached-done` (it sent
  `done`: the owner writes `timing.json`) and `attached-fail` (a failure's
  message, printed by the owner below the terminal view's last frame). Exit 0
  without `attached-done` is a loud failure, never a success.
- **Same protocol or nothing**: the hand-over needs the checkout's
  `# installer-attach: <v>` line to equal this script's; another version stops
  the install, asking to finish with the checkout's `./install.sh`. A
  checkout with no line at all predates the hand-over (an old tag stage 0
  could not hand to its own script): this script's steps install it, saying so.
- Run from a checkout (`./install.sh`), the script already is the checkout's:
  no hand-over. The dry run hands over too (to the script beside it), so the
  stream test runs the attached path every time.

## install.sh: the terminal view

Without a window the hub draws the stream itself (`render`), from the events
and the plan's arrays (`plan_data`):

- **interactive** (stdout a terminal, `TERM` not dumb, no `CI`): a status
  block redrawn in place (on every step change, else once a second) — one row
  per group (the running step's `doing`, when it named one, on a line under
  its row), the build's sub-steps with their counts while it runs, the
  overall bar, elapsed, time left, the last two log lines and the log path;
  the done screen after. A password prompt (`wait … password`) stops the
  redraws until it is answered. A pause draws the block's last frame, its box
  and the menu below; Try again or Skip with nothing else printed meanwhile
  erases all three and redraws the block in place (one header, no stale box);
  after Fix with Claude, Report, the log or the manual action
  (`pause-printed` in the run dir) the box and what was printed stay above
  the new block.
- **plain** (CI, a pipe): append-only `HH:MM:SS [n/N] <step>: …` lines —
  started (usually …), every 25 %, waits, each `doing` the step names,
  done in …, `equin is ready · …`.
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
for watching a renderer; `EQUIN_INSTALL_DRY_RUN_VIEW_EXIT=<step>` makes the
terminal view exit at that step's start. Held to the schema by
`window/cli/internal/dry-run-stream.test.ts` (window mode, events.jsonl,
timing.json, the plain view), with `HOME` a temp dir, under every bash (§
Tests run under every bash).

## Stage 0: which equin, and which view (`install.sh`, top)

`curl …/main/install.sh | bash` runs main's script, whose first job is to
hand over to the release it installs (`stage0`):

1. **Resolve**: `releases/latest/download/release.json` (a redirect, not the
   REST API: no rate limit), or `download/<tag>/…` for `--ref <tag>`.
2. **Download** into `~/.equin/install/bin/<tag>/` — `SHA256SUMS`,
   `release.json`, the tag's `install.sh`, and this platform's window binary
   only when the view may be the window (`--window`, or `DEFAULT_VIEW=auto`
   without `--terminal`) — all from that one tag. The window: for a v2
   manifest (`installers: 1`) `INSTALLER-SHA256SUMS` first — attached after
   the Release is published, last; absent (404), the terminal view, "this
   release's installer window isn't published (yet)" — then
   `equin-installer-<platform key>` if it lists one; for v1, the binary
   `release.json` names under the platform key.
3. **Verify** each against `SHA256SUMS` (the v2 window: against
   `INSTALLER-SHA256SUMS`) (`shasum -a 256 -c`, else GNU
   `sha256sum -c`: macOS's `/sbin/sha256sum` is BSD's and reads no list).
   A mismatch or a missing entry stops the install; the file is deleted,
   never run.
4. **Pick the view** (`choose_view`): the terminal by default
   (`DEFAULT_VIEW=terminal`, no reason printed) or with `--terminal`. Under
   `--window`, or `DEFAULT_VIEW=auto`: the window unless
   binary for this system, Linux without a display or a session D-Bus
   (WebKitGTK stalls ~30 s without one), SSH, `CI`, output not a
   TTY, or a sandboxed shell (`CLAUDECODE`, `APP_SANDBOX_CONTAINER_ID`) —
   then the binary's own `--probe` (a hidden window loading the page; a
   missing webkit2gtk fails before `main`) — the guesses apply to `auto`
   only. `--window` skips the guesses, not the probe, and stops loudly when
   it fails.
5. **Exec** `equin-installer --script <install.sh@tag> -- --release <tag>
   --checkout <ref> <install args>`, or `bash <install.sh@tag> --release …`.

`--release` marks the script as a release's (stage 0 never runs twice);
`--checkout` is what the clone checks out: the tag (`git checkout -B main
<tag>`, still tracking `origin/main`, so updates move it release to release),
or `main` for `--ref main` and for a fork (`--repo`) — the release's script
then hands the steps after the clone to main's own (§ The checkout's own
steps); a release whose script lacks the attach marker is not used for main
(this script's own steps, in the terminal). **Falls back to this
script's own steps, in the terminal, saying why** when no release could be
read (none published, no network: main's tip), or the release predates the
hand-off (`release.json` `handoff: null`: its tag). Run from a checkout
(`./install.sh`), stage 0 is skipped and that checkout is installed.
`--stage0-only` prints the decision instead (the stage-0 test,
`cli/internal/stage0.test.ts`, against a local fake release
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
    The **build slot** ([`waits`](plugins/waits), `judgeHolder`): waited past
    2 min AND the holder (the op log's oldest working op) showed no progress
    for 10 min — a deadline re-armed only when the holder moved.
  - **the step's own** — the failed command wrote its own diagnosis
    (installer/cli `reportInstallDiagnosis`, to the file
    `EQUIN_INSTALL_DIAGNOSIS` names; `own_diagnosis` reads it): its title,
    text and evidence, in the person's terms. When it names `leave-out`
    parts, the pause is optional and **Skip runs the step again without
    them** (`EQUIN_INSTALL_LEFT_OUT`, accumulated in `LEFT_OUT`) rather than
    leaving the step out whole. `./equin start` writes one for a part it could
    not prepare (§ One build of main per install). The Skip is recorded:
    right after its `resolved skip` install.sh sends a `notice` (`skipped`,
    the part's ids, "Installed without <part>", what that means — the
    diagnosis's `without` / `later`). A notice that answers a Skip (before the
    step's next event) is the person's choice: no banner, nothing to allow,
    no Add it now (`done_wait` skips ids in `LEFT_OUT`); every view's done
    screen names each one with what it means.
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
  change signal), brought to the front once it appears (`open -a`: it opens
  behind the window, which takes focus as it opens), never `sudo
  softwareupdate`. When the tools are in (the `apple-installer` wait's
  `end`), the window comes back above Apple's finished dialog ("The
  software was installed", which stays until clicked): `orderFrontRegardless`,
  since macOS may refuse to activate a background app. Apple's dialog is left
  for the user to dismiss, never clicked for them. **Linux in the window**: `sudo
  -A` with an askpass wrapper running the window's binary (`--askpass`), which
  asks the window over its socket for a password sheet.
- **Reproducing each on purpose** (dry run): `EQUIN_INSTALL_DRY_RUN_FAIL=
  <step>[:sigkill|:vanish|:quiet]` — sigkill under `sandbox-exec -p '(version
  1)(allow default)'` is the sandbox rule, vanish (a program deleted right
  after it was made) with a process named `JamfProtect` running is the
  security rule (`cc` a sleeping C program named so), quiet with
  `EQUIN_INSTALL_STALL_S=1` the watchdog, `<step>:part` an optional part of
  the step failing with the step's own diagnosis until a Skip leaves it out;
  `EQUIN_INSTALL_DRY_RUN_OPTIONAL=<step>` offers Skip, `EQUIN_INSTALL_DRY_RUN_NOTICE=1` the part left out.
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
- **Waits name who holds them** ([`waits`](plugins/waits)): the build's op
  profiler (`withInstallWaits`, build's `cli/internal/install-waits.ts`)
  reports the build lock, the duress gate and the host CPU grant; every CLI
  admission (`cliExecContext` — `./equin start`'s dependency installs) the
  host CPU grant; a convergence run its deploy lock. Each as a `wait` event
  with the op holding it (the grant: the oldest admitted op in the op log; a
  lock: the oldest running op of its kind), and the stall rule armed on it.

## One build of main per install

`./equin start` brings the background service up, and its first boot
deploys main at once (a convergence run, `build/converge`; a first deploy —
nothing served yet — runs no validation at all, so the build step is codegen,
the interface and the deploy). So `start` builds
every program a login service runs (the menu-bar icon, the disk-speed check)
BEFORE it starts the gateway: built after, one would queue for the host's
build slot behind main's whole first build (2026-11-18: a 5 s compile waited
~9 min, booked to `start`), since admission on a fresh machine runs on its
1-slot floor.

In an install, a program that fails to build stops `start` BEFORE the
gateway (by hand, `start` brings the gateway up first), as an
installer notice (what the part gives, why it failed in the user's words —
the OS libraries it lacks, or a failed build with its output as evidence —
and that it is optional) and as the start step's own diagnosis: Try again
rebuilds it with nothing else on the machine (were the gateway up, its first
boot's build of main would hold the build slot and the retry would queue
behind it: 32 s to 5 min on the 2026-11-18 Linux VMs); Skip runs `start`
again with the part left out (`--leave-out`, here `EQUIN_INSTALL_LEFT_OUT`).

**What the parts need from the OS** is declared by each part's dependency
(`Dep.systemPackages`, apt names — the menu-bar icon's GTK / WebKitGTK), and
by every dependency whose libraries each install prepares
(`systemPackages.everyInstall` — Chromium's, which main's unattended deploy
checks the layout in and cannot ask a password for); the start step's body
(`start_services`) asks `./equin start --system-packages` and installs what is
missing (one sudo) before `./equin start`. A failed install does not stop the
step: `start` then fails on the part, with the packages named, and a
dependency used later says what it lacks when it is installed.
`--system-packages` answers on one `system-packages:` line (apt names, each
checked before it reaches apt; apt waits out a dpkg lock — a fresh machine's
own updates) and one `system-setup:` line per command a dependency's own tool
installs its libraries with (Playwright's `install-deps`, whose package list
depends on the distribution release): what it is, then the argv,
tab-separated, run as root. A
machine with no desktop (`hostDesktop`: no display outside SSH, no display
manager, no desktop session installed) never builds or registers a
`graphical` service — `start` says it left it out.

The install's build step is the same convergence run (`./equin build
--allow-main --converge`): it waits on the deploy lock for the service's run
and finds main deployed, or deploys it itself if it got there first. While it
waits it **follows** the service's build (installer/cli `requestFollow` /
`followableBy`): it publishes a request (`worktreeArtifacts.installFollow`,
naming its event FIFO and its pid), and main's build — at its next sub-step or
count — takes it, ends the step's wait, tells it the sub-steps already behind
it (start + done with their `ms`, or skipped), and from then on reports its
sub-steps and counts to that install as the step's own. So the build step
shows main's build with its real sub-steps, and time left counts it as work,
not a wait. The waiter withdraws the request once it holds the lock; a build
that took it stamps `followedBy`, so the waiter does not report the sub-steps
skipped after it. A stale request (its pid gone, its FIFO without a reader) is
ignored; an install that ends mid-build (EPIPE) or stops draining its FIFO
(EAGAIN — the build writes each event once, never waits on it: it is main's
deploy) is let go. It builds main on
its own (`--skip-checks`; with nothing served the build runs no validation
anyway — `build/converge` § A first deploy) only when main is still not deployed at HEAD
afterwards (the service's build of it failed — a convergence run decides a
commit once), so that failure is the step's own output. Done = main's receipt
`ok` for HEAD.

## Estimates (`core/estimates.json`)

**One table per estimate set** (`EstimateSet`, `estimateSetOf(platform,
mode)`; install.sh's `EST_SET`): `macos-window`, `macos-terminal`, `linux`.
On macOS the view decides how Apple's developer tools come in — Apple's own
dialog in the window (166–211 s measured), softwareupdate headless in the
terminal (~80 s) — so each view is measured apart; on Linux every view runs
apt, so they share one. A run counts only in its own set; a set no run
measured keeps its committed table. install.sh's block is `est_s <set>
<step>`.

`./equin installer estimates [--from <dir…>] [--only <step…>]` takes each
step's median over every finished real install run (this machine's run dirs,
plus run dirs collected elsewhere — a VM's, say): its `timing.json`, else the
`events.jsonl` it is read from (`timingFromEvents`: each step's last `done`
time, only for a stream that reached `done`; a build sub-step skipped inside a
build that ran to `done` counts as 0 — install.sh's `write_timing` writes the
same). Dry runs never count (their plan says `dryRun`). `--only` re-measures
just the listed steps and keeps every other one's committed estimate — for
runs that predate a change to those steps. It writes `core/estimates.json` and
install.sh's generated `estimates` block (`--from-json` rewrites only the
block). `installer:estimates-in-sync` holds the two equal. A null step shows
no time, and no total is shown while any remaining step has none.

Current values (2026-11-18), all from clean installs in fresh VMs (Tart, 4
CPU / 8 GB). `tools`, `mise`, `clone`, `toolchain`: `macos-window` from three
window installs (v2026.11.17.2 ×2, v2026.11.18.3), `macos-terminal` from two
terminal ones (v2026.11.17.2, v2026.11.18.3), `linux` from one Ubuntu arm64
terminal install of v2026.11.18.3 (with `start` too: 109 s) — `--only` those
steps. Every set's build sub-steps are macOS's (below): the one Linux run
predates c4d3c03003's faster first build, and its database sub-step was the
followed build's whole time (fixed since: a followed build reports only the
part after the install's step began). macOS `start`, `build` and its sub-steps come
from two `--ref main` installs at c15ff3541d / 5a990409f1 (`--only` those),
once `start` built the services' programs before the gateway: start 122 s
both, build 564 s and 579 s (database 1, deps 1, codegen 23, interface ~523,
deploy 11). In both, the install's own build step took the deploy lock before
the service's first-boot run started, so it built main itself; following the
service's build (§ One build of main per install) covers the other order.

## Sub-plugins

- `window` — the native installer window (`equin-installer`).
- `release-assets` — what a release tag publishes (the GitHub Actions
  workflow: the Release first — `release.json`, `SHA256SUMS` — then the
  window's binaries and `INSTALLER-SHA256SUMS` attached) and its checks.
- `waits` — a `./equin` step's waits, reported naming their holder, and the
  stall rule.

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
    - `EstimateSet`
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
    - `StepEstimates`
    - `timingFromEvents`
    - `WaitHolder`
    - `WaitOn`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps.ensureDepViaCli`
    - `infra/deps/download.download`
    - `infra/deps/download.downloadedFile`
- Cross-plugin:
  - Imported by:
    - `framework/cli/bootstrap`
    - `framework/cli/build`
    - `framework/cli/op-runtime`
    - `framework/cli/start`
    - `installer/release-assets`
    - `installer/waits`
    - `installer/window`
- Exemptions:
  - Exempts itself from: `paths:no-hardcoded-paths` — `core/internal/report.test.ts` (sanctioned)
- Cli:
  - Exports (values):
    - `emitInstallEvent`
    - `enterBuildSubStep`
    - `finishBuildSubSteps`
    - `followableBy`
    - `installEventsOn`
    - `installLeftOut`
    - `reportInstallDiagnosis`
    - `reportInstallNotice`
    - `reportInstallProgress`
    - `reportInstallResolved`
    - `reportInstallStall`
    - `reportInstallWait`
    - `requestFollow`
- Test helpers:
  - Deps: `@plugins/installer/deps/testing`
    - `installShBashes` — Every bash install.sh's tests must pass under, wherever they run: GNU bash 3.2 and 5.2 built from pinned source (the `installer-test-bashes` dependency, installed on first use), plus `/bin/bash` — the shell `curl … | bash` actually runs here (Apple's patched 3.2 on a Mac, the distribution's 5.x on Linux).
    - Types: `InstallShBash`
- Sub-plugins:
  - **`release-assets`** — Watches the release workflow on GitHub (GitHubEvents.Watch: the product repo's installer-release.yml and its Releases), so a failed release run files a report naming the re-publish command, and the…
  - **`waits`** — How a `./equin` command run as an install step reports a wait on another task, naming its holder from the op log: installGrantHooks (a host CPU grant wait — any CLI admission, a build's or a…
  - **`window`** — The installer window: equin-installer, a small wry/tao Rust app (rust/) that runs install.sh as its child — events on fd 3, decisions on fd 4 — and draws the stream in a page bundled into the binary…

<!-- AUTOGENERATED:END -->
