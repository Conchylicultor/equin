# The equin installer window: a native window over install.sh, built per release tag

Design only, for review. Task `task-1794924169-qgnyrv` (onboarding audit, decision D8). Approved mockup: `proto-1794832268-wlybzk` (`view=window|terminal|hosting`, `state=running|failed|fixing|done`, `failure=sandbox|permission|security|stall`).

The mockup's *hosting* view is replaced by this doc. It proposed a compiled Bun program serving a browser tab. That idea is superseded by the decisions below.

## Context

Today `curl … install.sh | bash` prints its plan and then 10–15 minutes of raw `mise`, cargo and vite output. It shows no progress and no time left, and a failure is a bare red line. New users can't tell a slow install from a stuck one, or a real bug from their own setup (a sandboxed shell, company security software).

Decided with the user (2026-11-17):

- **The window wraps the script, not the other way round.** `install.sh` (and the `./equin` commands it runs) stays the only place the install steps live. It emits a stream of structured events. Two renderers read that one stream: a native window, and the script's own terminal view.
- **The window** is a small Rust app built on wry/tao, fixed at 760 × 640, drawing the approved mockup's HTML.
- **Delivery is curl only.** There is no notarization. A file downloaded by curl is not quarantined, so an ad-hoc signature is enough. A double-click, notarized installer app is parked on the Backlog page; this design leaves room for it.
- **GitHub Actions builds it on every release tag** (`v<YYYY.MM.DD>[.N]`, cut by `./equin version cut`). Three files are attached, with checksums, to that tag's GitHub Release: universal macOS, Linux x64 and Linux arm64. On Linux without webkit2gtk the install falls back to the terminal view.
- **The user's 5 rules apply to every installer message:**
  1. No internal names.
  2. Say what equin was doing and why it helps.
  3. Say why it was blocked, in the user's terms.
  4. Say what the user can do now, and what happens if they skip.
  5. Raw lines go only in the log or evidence area.
- **The install needs no macOS permission.** Anything that does is optional and skippable (landed in `task-1794922059-nmdsaa`).

## The shape in one picture

```
curl …/main/install.sh | bash                       (stage 0: tiny, stable bootstrap)
  │  resolve the newest release → fetch release.json, SHA256SUMS, install.sh@tag,
  │  equin-installer-<platform>; verify every sha256
  │
  ├─ window possible? ──yes──▶ exec equin-installer --script <install.sh@tag> -- <args>
  │                               │  (native window, parent process)
  │                               └─ bash install.sh@tag --events-fd 3 --control-fd 4
  │                                     ├─ steps → events (fd 3) ──▶ window page
  │                                     └─ decisions (retry/skip/quit) ◀── fd 4
  │
  └─ no ─────────────────────▶ exec bash install.sh@tag --terminal
                                  (the same steps; the events drawn by the script itself:
                                   interactive on a TTY, plain timestamped lines otherwise)
```

One step engine (`install.sh` together with `./equin start` / `./equin build`) produces one event stream. Two views draw it.

## 1. The event stream (protocol v1)

### Format

The stream is NDJSON with one event per line. Every event carries `v: 1`, `t` (an ISO timestamp) and `type`. Each event is written in a single `write` of less than `PIPE_BUF`, so `install.sh` and the `./equin` children it runs can share the fd without their lines interleaving. Every event is also appended to `~/.equin/install/<run>/events.jsonl`; `~/.equin/install/latest` points at the newest run. The window reloads from that file, and `--fix` and `--report` read it.

| `type` | Fields | Emitted by |
|---|---|---|
| `plan` | `release`, `platform`, `steps: [{id, label, group, est_s, optional?}]`, `mode` (window/interactive/plain) | install.sh at start, once it knows which steps are already done (done steps are listed as `skipped`) |
| `step` | `id`, `state: start\|done\|skipped\|failed`, `ms?` | install.sh's `run_step`; `./equin build`'s phases |
| `progress` | `id`, `done`, `total`, `unit` (`crates`, `plugins`, `packages`, `%`) | `./equin build` (cargo JSON messages, the artifact builder's counter, bun install); `git clone --progress`; `softwareupdate --verbose` |
| `action` | `text`: a user-facing "what's happening now" line | install.sh, and `./equin` through its phase table |
| `log` | `step`, `stream: out\|err`, `line` | `run_step`'s line reader (all child output) |
| `wait` | `step`, `on: host-grant\|lock\|apple-installer\|password`, `holder?: {op, kind, startedAt, lastOutputAt}` | the op-runtime grant wait (the profiler already records waits); install.sh for Apple's dialog |
| `notice` | `id`, `kind: optional-skipped`, `title`, `text`, `action?` | `./equin start` when it skips an optional login service (`BundleWriteRefusedError`, already landed) |
| `pause` | `step`, `kind: sandbox\|permission\|security\|stall\|unknown`, `title`, `text`, `evidence: string[]`, `optional`, `manual?: {label, command}`, `chips` | install.sh's `diagnose` (§3) |
| `done` | `url`, `ms` | install.sh after the build receipt is confirmed |
| `exit` | `code` | install.sh's EXIT trap |

### One schema, enforced

- **A zod schema in core.** `plugins/installer/core` exports `InstallEvent` as a zod discriminated union.
- **The page uses it.** The window page imports the schema and parses every line it receives.
- **`./equin` emits through one helper.** `emitInstallEvent(e: InstallEvent)` is type-checked. It writes only when `EQUIN_INSTALL_EVENTS_FD` is set, so builds outside an install are unaffected.
- **install.sh** writes JSON by hand through one `ev` function with a `json_str` escaper.
- **A test** runs `install.sh --dry-run` (it emits the plan and a scripted step and pause sequence without touching the machine) and parses every line against the schema. This is the guard against the bash emitter drifting from the schema.

### Messages live in the events

`title`, `text` and `action` are produced by the step engine and never by a renderer. Both views draw them as they come, so the 5 message rules are applied in exactly one place.

### Build sub-steps

The mockup's "Build the app" sub-steps (dependencies, native modules, code generation, database, interface, start) come from `./equin build`'s existing profiler spans (`buildProfilerStart` in `plugins/framework/plugins/cli/plugins/op-runtime/cli/profiler.ts`).

- **Typed phases.** A span gains an optional typed `installStep: InstallStepId`, a closed union in `installer/core`. The span emits `step` start and done events.
- **Why typed.** Renaming a span cannot silently drop a step; tsc rejects a step id that no span declares.
- **Untagged spans** go only to the log.

### Time estimates

- **The estimate table.** `plugins/installer/core/estimates.json` holds per-step medians from clean installs.
- **How it is refreshed.** `./equin installer estimates` regenerates it from timing files. Every install writes `~/.equin/install/<run>/timing.json`. Build sub-steps can also be read from full-build profiles with step-baseline's `readBuildSteps` (`plugins/build/plugins/step-baseline/core`).
- **First release.** It ships with medians measured on a few real clean installs.
- **Running estimate.** The renderers rescale the remaining estimate by this machine's pace on the steps already done, as the mockup does.
- **Unknown steps.** A step without a median shows no number ("Step 5 of 5"), never a made-up one.

## 2. The window app

### Where it lives

A new top-level umbrella, `plugins/installer/`, with these sub-plugins:

- `core`: the event schema, step ids, the estimates file and the message catalog's types.
- `window`: the Rust crate (`rust/`) and the page source.
- `release-assets`: the CI workflow source and asset names (§6).

The repo-root `install.sh` stays where it is, because its URL is the documented entry point.

The page is a standalone bundle that is neither the app's `web` runtime nor an import target. It needs a folder kind that may import other plugins' `core`, which the page uses to call `buildIssueUrl`. Proposal: a new leaf folder kind `standalone-page` (one vocabulary entry plus its row in `boundary-config.ts`). The spike decides the final name.

### Crate

- **Name and stack.** The crate is `equin-installer`, built on **wry + tao directly, not Tauri**. The menu-bar helper reaches the same libraries through Tauri 2 (lock: wry 0.57.2, tao 0.37.2, in `plugins/companions/plugins/menu-bar/rust`). We pin the same versions.
- **Why not Tauri.** Tauri brings a config file, ACL and capabilities, none of which a one-page, one-window, one-child-process program needs. The direct build keeps the binary at a few MB.
- **Window.** Fixed at 760 × 640 and not resizable. On macOS the title bar is transparent with a full-size content view and a hidden title, so the mockup's dark canvas runs under the traffic lights. Linux uses normal decorations.
- **Page loading.** The page loads from a custom protocol (`installer://app/`) serving the HTML compiled into the binary with `include_bytes!`. Nothing is fetched from the network: the mockup's unpkg React and Google Fonts are dropped. The page uses the system font stack, or an embedded Inter subset. That is decided in the spike, and the system font is the default.
- **Page source.** TypeScript (Preact, or plain DOM) bundled by `bun build` into one inline HTML file. CI builds it before `cargo build`, and `build.rs` fails loudly if the file is missing. It is ported pixel-perfect from the mockup's window view.

### Process model

`equin-installer --script <path> [--events-fd …] -- <install args>`:

1. It opens a pipe for events (child fd 3) and one for control (child fd 4), and spawns `bash <path> --events-fd 3 --control-fd 4 <args>` in its own process group. The child's stdout and stderr are also piped to the window, which turns them into `log` events if the script did not already. The terminal that started the install keeps printing one plain line per step plus a line saying "Installing in the equin window. Closing it stops the install; running the installer again resumes."
2. It keeps every event in memory and sends each one to the page with `evaluate_script("installer.push([...])")`, batched per frame. When the page loads (or reloads) it replays the backlog, so the page is a pure function of the event list.
3. The page sends commands to Rust with `window.ipc.postMessage(json)`: `retry`, `skip`, `quit`, `fix {target}`, `report`, `open-url`, `reveal-log`, `copy`, `password`. Rust validates each against a closed enum. `retry`, `skip` and `quit` are written to the child's fd 4 as single lines.
4. **Closing the window during an install** asks "Stop installing? Running the installer again picks up where it stopped." Confirming sends SIGINT to the child's process group. Every step checks before it acts, so a rerun resumes.
5. **Done** shows "You're all set" and **Open equin**, which opens the default browser at `http://equin.localhost:9000` (`open` / `xdg-open`). The window exits after that, or when it is closed.
6. **One install at a time.** install.sh takes an `flock` on `~/.equin/install/lock`. A second run reports "an install is already running" and exits; in window mode it focuses the existing window through the menu-bar crate's single-instance socket pattern (`rust/src/instance.rs`).
7. **Exit codes** pass through: the window process exits with the script's code.

### Why the window is the parent

`curl | bash` gives no file to re-run, and the terminal is the only thing the user is looking at. Stage 0 `exec`s the window, so the shell becomes the window process. The script is its child, the terminal stays attached, and Ctrl-C still stops everything.

## 3. Failure detection

Every step runs through `run_step <id> <cmd…>`. It emits `step start`, reads the child's output line by line (each line becomes a `log` event and also goes to `install.log`), and on a non-zero exit calls `diagnose <step> <exit>`.

`diagnose` tries the rules in order. The first match emits a `pause`; no match emits `kind: unknown`. Each rule needs both a symptom and a corroborating fact, because a single symptom alone produces confident wrong messages.

### sandbox (the app the install was started from stopped it)

- **Symptom:** the step's exit is 137 or 9, or its log contains `signal: 9, SIGKILL`.
- **Fact:** an ancestor of the script is `sandbox-exec` (walking `ps -o ppid=,comm=` up to launchd).
- **Checked up front too.** The same ancestry test runs at stage 0. A sandboxed parent can stop the build minutes in, and may not let a window appear at all, so a sandboxed run goes straight to the terminal view. It then pauses before step 1 with the same message instead of failing 6 minutes in.
- **Manual action:** "Continue in Terminal". It writes `~/.equin/install/<run>/continue.command` (`cd <dir> && ./install.sh`) and runs `open` on it. A `.command` file opens in Terminal.app without any Automation permission. If `open` itself is refused, the message tells the user to open Terminal and run the shown command.

### permission (macOS refused to add the menu-bar icon / app shortcuts)

- **Symptom and fact** are both already structured: `./equin start` raises `BundleWriteRefusedError` and skips the optional login services (`installServiceExecutable`, `plugins/infra/plugins/launcher/plugins/login-services/machine/internal/macos-app.ts`).
- **Change:** start emits a `notice {kind: optional-skipped}`, and the install does **not** stop.
- **Window behaviour:** the window shows the mockup's paused card as a non-blocking banner while the build goes on. **Skip** dismisses it. The done screen keeps "Installed without the menu-bar icon and app shortcuts. **Add it now**".
- **Add it now** opens Privacy & Security → App Management (`x-apple.systempreferences:…Privacy_AppBundles`) and runs `./equin start --only <id>` when the user comes back and clicks it.
- **Deviation from the mockup.** The mockup blocks the install on this pause. A 15-minute install should not wait unattended on an optional item.

### security (company security software removed part of equin)

- **Symptom:** a binary the step just produced is gone, or exec fails with ENOENT or EPERM, within seconds of being written. `run_step` compares a step's declared outputs (gateway, helper) before and after.
- **Fact:** a known endpoint agent is present. A small table maps a process name or path to a product name: Jamf Protect, WithSecure/F-Secure, CrowdStrike Falcon, SentinelOne, Microsoft Defender, Sophos. The table also checks for an MDM enrollment (`profiles status -type enrollment`, which needs no root).
- **Message:** names the product found. The manual action is **Copy request for IT**, a ready-made message listing the folders to allow (`~/.equin`, the checkout) with the OS and architecture.
- **No known agent found:** the failure is `unknown`, and the message never guesses.

### stall (the install is waiting on something that stopped responding)

- **Hard signal.** The op-runtime host-grant wait emits `wait {on: host-grant, holder}`. The rule fires when the wait has lasted more than 2 min **and** the holder's last output is more than 10 min old.
  - **Manual action:** "Stop the old task", which stops that op through the existing op CLI. Verify the exact verb in the spike.
- **Generic signal.** No event at all from the step for `max(10 min, 3 × its median)`. This is a watchdog in `run_step`: `read -t` on the child's output pipe, re-armed on every line.
  - **Why this isn't polling:** it is a deadline on work we cannot observe otherwise.
  - **Result:** a `stall` pause whose text says only what is known ("No progress for 12 minutes while building the interface"). **Keep waiting** is offered, never an automatic kill.

### unknown

Any other failure: "Installation paused", the step's label, the last 20 log lines as evidence, and Fix with Claude and Report issue.

The full diagnosis is written to `~/.equin/install/<run>/diagnosis.json`, which `--fix`, `--report` and the Claude prompt read.

### Pause and decision protocol

After a `pause`, the script blocks until it gets a decision:

- **Window:** a line on fd 4.
- **Interactive terminal:** a key read from `/dev/tty`, using the mockup's terminal menu (`[f] Fix with Claude`, `[r] Report`, `[l] Show the full log`, `[q] Quit`).
- **Plain mode:** no wait. The script prints the next commands and exits 1.

`retry` re-runs the step. `skip` is accepted only when the pause says `optional`. `quit` exits 1, and running the installer again resumes.

## 4. Fix with Claude, Report issue, Skip

### Fix with Claude

The control is the mockup's split button with a remembered target: the **Claude app** or **Claude Code in Terminal**.

**The prompt.** It is written to `~/.equin/install/<run>/fix-prompt.md` and holds:

- what the install was doing and why;
- the diagnosis (title, text, evidence);
- OS, architecture and release;
- the paths of `install.log` and `events.jsonl`, with the last 150 log lines inline;
- the rules: explain before changing anything, never disable security software, say plainly when a fix needs the user or IT;
- **the resume command** (`~/.equin/install/resume`, a tiny script that writes `retry` to the waiting installer through `~/.equin/install/control.fifo`).

Claude Code runs the resume command itself once it has fixed the problem. The window's **Try again** button does the same.

**Claude Code in Terminal.** The installer writes `fix.command`, which runs `cd <checkout or ~> && claude "$(cat fix-prompt.md)"`, and runs `open` on it.

- Using `open` on a file avoids the Apple Events/Automation permission that scripting Terminal would trigger.
- If `claude` is not on PATH, the `.command` first installs Claude Code with Anthropic's official installer (the user sees it happen in Terminal), then starts it.
- Linux: the same command in `x-terminal-emulator`, or `$TERMINAL`.

**Claude app.** The installer copies the full prompt to the clipboard and opens the app. If the app supports a prefill deep link, it is used and the prompt is cut to fit. The window says "The problem and log are on your clipboard: paste them into Claude." The app cannot run commands on the machine, so resuming is the user's **Try again**.
- *Open question:* is there a supported prefill URL (`claude://…` / `claude.ai/new?q=`)?

**While Claude works,** the window shows the mockup's "Claude is working on it" card (Show Claude, Try again). The script keeps waiting on its control fd.

**Terminal view:** `[f]` does the same, and the Claude Code path runs in the same terminal. In plain mode, `./install.sh --fix` starts `claude` with the prompt; `--yes` is needed for it to act without a TTY.

### Report issue

- **The URL.** The page builds it with `buildIssueUrl` (`plugins/integrations/plugins/github-issues/core/issue-url.ts`), already length-safe at 7,500 characters, against `SOURCE_REPO_URL` (`plugins/framework/plugins/product-name/core`) with `labels: ["install"]`.
- **Title:** `Install: <pause title>`.
- **Body:** what happened (the plain text), the evidence, the release, the OS and architecture, and "The full log is at ~/.equin/install/latest/install.log; drag it here to attach it."
- **Redaction:** paths are redacted (`$HOME` becomes `~`, and the user and host names are removed) before the URL is built.
- **How it opens:** the window opens the URL in the browser (an `open-url` command, limited to `https://github.com/` URLs). Nothing is sent until the user submits the issue on GitHub. **Reveal log** shows the file in Finder.
- **Terminal:** `[r]` and `--report` print the same URL and open it when there is a display.
- **Single source:** the URL builder is the TS core, so the terminal uses a tiny `./equin installer report-url` after the clone. Before the clone, a minimal bash builder covers the pre-clone steps: title plus evidence only, with no length logic needed.

### Skip

- **When:** only for a pause the engine marks `optional` (today: the login-service notice).
- **Where:** the window's Skip button, or `[s]` in the terminal.
- **Effect:** the step is recorded as `skipped` in `timing.json` and on the done screen ("Installed without … Add it now"), never silently.

## 5. First-time macOS setup (Apple's command-line tools)

The window binary needs neither git nor the command-line tools. It uses the system WebKit, and stage 0 needs only `curl` and `shasum`, which are in the base system. So the window can appear at second 0 on a bare Mac.

**Window mode** uses **Apple's own dialog** (`xcode-select --install`), not `sudo softwareupdate`. The user sees Apple's trusted prompt, which asks for whatever authorization it needs; the equin window never asks for an admin password.

- **The window shows:** "Installing Apple's developer tools: follow Apple's window, click Install. This can take 5–20 minutes." The bar is indeterminate, and the step's estimate is only counted when the tools are missing.
- **The script waits** until `xcode-select -p` succeeds or the Apple dialog process is gone, checking every 5 s.
  - **Why polling here:** this is a documented exception. It is an OS dialog with no change signal, and the existing script already polls the same way.
- **Dialog closed with no tools installed:** a `pause` (kind `unknown`, title "Apple's developer tools weren't installed"). Retry opens the dialog again.

**Terminal mode** keeps today's headless `sudo softwareupdate` route (the marker file plus `--verbose`, whose percentages become `progress` events). It works over SSH, where no dialog can be clicked.

**Linux, window mode.** apt and `loginctl enable-linger` need sudo. The script runs them with `sudo -A`, with `SUDO_ASKPASS=equin-installer askpass`. That helper asks the running window over a socket to show a password sheet ("equin needs your password to install git and a C compiler. It goes to sudo only and is not stored.").

Later, these steps could run in parallel with the tools download (mise and the toolchain do not need the tools). That is not part of this plan.

## 6. Release builds: GitHub Actions and signing

The repo has no CI today. A new `.github/workflows/installer-release.yml`, triggered `on: push: tags: ['v*']` and by `workflow_dispatch` with an input `tag` for rebuilds, runs these jobs.

### 1. validate

The tag must match the release grammar `^v\d{4}\.\d{2}\.\d{2}(\.\d+)?$`, the same as `RELEASE_TAG` in `plugins/upstream/plugins/release/core/internal/release-tag.ts`. A small `./equin` check keeps the workflow's regex and that one equal. Any other tag (e.g. `website-media`) ends the run without error.

### 2. page

Set up the toolchain from the repo's `mise.toml`/`mise.lock` (`jdx/mise-action`), so Bun and Rust are the exact versions mise records. Then `bun build` the page and upload it as an artifact.

### 3. macOS

On `macos-14`:

- Build `aarch64-apple-darwin` and `x86_64-apple-darwin` with `--locked --release`.
- `lipo -create` them into `equin-installer-macos-universal`.
- **Ad-hoc sign** it with `codesign --force -s - …`. lipo invalidates the linker's per-arch ad-hoc signature, and arm64 refuses to run unsigned code.
- Smoke-test with `--version` and `--self-test`, which open and close a hidden window.

### 4. Linux

A matrix over `ubuntu-22.04` (x64) and `ubuntu-22.04-arm` (arm64). Building on 22.04 gives a glibc 2.35 baseline and links `libwebkit2gtk-4.1`.

- Install `libwebkit2gtk-4.1-dev`.
- Build and smoke-test (`--version`) the binaries `equin-installer-linux-x64` and `equin-installer-linux-arm64`.

### 5. release

Runs with `contents: write`, `id-token: write` and `attestations: write`. It collects these assets:

- the 3 binaries;
- `install.sh` from the tag;
- `release.json`: `{tag, commit, eventsProtocol: 1, assets}`;
- `SHA256SUMS`, covering all of the above.

Then it runs `actions/attest-build-provenance` on the binaries. That costs nothing now and lets a later `gh attestation verify` prove where they came from.

Last, `gh release create <tag> --verify-tag --notes-from-tag` with every asset, published in one go. A GitHub Release only exists once all its files do, so "latest" never points at a half-built release.

### Signing today and later

- **Today:** ad-hoc only, with no secrets. A curl download carries no quarantine attribute, so Gatekeeper never assesses it.
- **Later:** the notarized double-click app (Backlog) adds a job that wraps the same universal binary in `equin Installer.app`, signs it with Developer ID (`codesign --options runtime`, cert and password as Actions secrets), notarizes with `notarytool`, staples, and attaches a `.dmg`.
- **Why it stays a one-job addition:** the binary already carries its own bootstrap mode. With no `--script`, it downloads and verifies `install.sh` itself, so the app needs no shell around it. Build that mode in task 4 so the app is purely additive.

### `./equin version cut`

The cut is unchanged; the tag push triggers the workflow. The cut prints the Actions run URL. A follow-up, not in this plan: the health report's release row shows the installer build state.

## 7. install.sh: stage 0, download and verify, which commit to install

### Stage 0

Stage 0 is the top of `install.sh` on `main`. Keep it small and stable; it is the only part served from `main`.

1. **Parse the args.** New args: `--terminal`, `--window`, `--ref <tag|main>`, `--fix`, `--report`, `--dry-run`, plus `--events-fd` and `--control-fd`, which are internal.
2. **Resolve the release** with `https://github.com/equinai/equin/releases/latest/download/release.json`. This is a redirect, not the REST API, so there is no 60-requests-per-hour limit. `--ref <tag>` pins one release.
3. **Download** into `~/.equin/install/bin/<tag>/`: `SHA256SUMS`, `install.sh`, and the platform's binary when window mode is possible.
4. **Verify** every file against `SHA256SUMS` with `shasum -a 256 -c` (macOS) or `sha256sum -c` (Linux). A mismatch is fatal ("The download was damaged or changed. Nothing was installed."). It never falls back to running unverified code.
5. **Decide the view.** Use the window when all of these hold:
   - macOS, or Linux with `$DISPLAY` or `$WAYLAND_DISPLAY`;
   - not over SSH (`$SSH_CONNECTION`);
   - no `$CI`;
   - stdout is a TTY;
   - no `--terminal`;
   - no sandboxed ancestor (§3);
   - `equin-installer --probe` exits 0. On Linux this catches a missing webkit2gtk, because the dynamic loader fails before `main`. The probe's stderr is kept for the log.

   Otherwise use the terminal. `--window` forces the window and fails loudly if it cannot open.
6. **Hand off:** `exec` the window or `exec bash <install.sh@tag>`.

Without a release yet (releases before this ships carry no assets), or when the download fails for network reasons, stage 0 runs the steps in the terminal view **from the tag's or main's own script** and says why. A checksum mismatch is never treated as a network failure.

**Trust.** SHA256SUMS comes from the same GitHub that serves `install.sh`, so it catches corrupted or truncated downloads and mixed releases, not a compromised GitHub. The attestations are the path to authenticity if that is wanted later (*open question*).

### Install the newest release, not main's tip (recommended)

Now that clones follow releases (`plugins/upstream`, `research/2026-11-17-global-release-updates.md`), a fresh install clones and checks out the release tag. It runs `git clone`, then `git checkout -B main <tag>`, with `main` tracking `origin/main`.

**Why:**

- The release's build is known to have passed; `version cut` requires main's build of that commit to have exited 0.
- The window binary and `install.sh` come from exactly that commit, so the protocol matches by construction.
- The new clone's updates row reads `current` until the next release, instead of a tip that may be mid-change.

`--ref main` keeps the old behaviour for developers. It uses the newest release's window binary, which works because events carry `v` and the page refuses an unknown major version with a clear message.

An existing clone (`./install.sh` from a checkout) installs that checkout as today and never moves it.

## 8. Reused, not rebuilt

| Need | Existing code |
|---|---|
| Native window and webview | Same wry/tao versions, plus the macOS title-bar, ATS and single-instance patterns from `plugins/companions/plugins/menu-bar/rust` (`window.rs`, `main_frame.rs`, `instance.rs`) |
| Build sub-steps and waits | `buildProfilerStart` spans and their wait records (`op-runtime/cli/profiler.ts`) |
| Estimates | `readBuildSteps` / step-baseline profiles (`plugins/build/plugins/step-baseline/core`) |
| Release identity | `parseReleaseTag` / `RELEASE_TAG` (`plugins/upstream/plugins/release/core`), `./equin version cut` |
| Pinned-asset conventions | `githubReleaseDownload`'s pin shape and the `{tag}` asset template (`plugins/infra/plugins/deps/plugins/download/deps/internal/github-release.ts`): same asset naming, so equin's own `deps` could later pin the installer |
| Permission-refused handling | `BundleWriteRefusedError` and start's optional-service skip (landed) |
| Issue URL | `buildIssueUrl` plus `SOURCE_REPO_URL` |
| Prerequisite checks | `doctor.sh` stays the authority on what is missing; its `miss` lines become `log` events, and its text gets the 5-rule rewrite (already its own D0 box) |
| Signing | Ad-hoc in CI needs no helper. `plugins/infra/plugins/codesign` (`signBundle`, identity resolution) is the model for the later Developer ID job |
| Data root | `data_root()` already in install.sh; `install/` is declared as a data dir by `plugins/installer/data-dirs` |

## 9. Risks

- **Sandboxed parent shells** may block the window or WebKit's helper processes. Mitigation: detect the sandbox at stage 0 and go to the terminal. The `--probe` self-test also opens a real hidden webview, not just a link check.
- **Linux webview availability.** webkit2gtk-4.1 is missing on most servers and on older distros (Ubuntu 20.04 has only 4.0). That is expected: the probe falls back to the terminal. glibc older than 2.35 also falls back, with a clear line in the log.
- **Protocol drift** between bash, `./equin` and the page. Mitigation: one zod schema, the typed emitter, the typed `installStep` on spans, and the `--dry-run` schema test.
- **Bash complexity.** install.sh grows a step runner, a JSON emitter, diagnose rules and a terminal renderer. Mitigation: keep the interactive renderer modest (a redrawn status block plus a scrolling dim log), and test `--dry-run` output in both terminal modes. If it passes ~800 lines, split it into release assets that stage 0 also verifies.
- **Mixed versions.** Stage 0 on `main` is newer than the tag's script. Keep stage 0 limited to resolve, download, verify and exec, and version `release.json`.
- **Estimates** are wrong at first. Ship only measured medians, and show no number rather than a guessed one.
- **Claude app hand-off** may have no prefill path; the clipboard is the fallback. Claude Code may be absent; the `.command` installs it in front of the user.
- **The first tag** after this lands is the first time CI ever runs, so test with `workflow_dispatch` on an existing tag first. macOS runner minutes are free for a public repo; check whether `equinai/equin` is public.
- **The canonical repo's own release** must not depend on CI. If the workflow fails, the tag still exists and stage 0's no-assets fallback still installs, in the terminal view.

## 10. Build tasks (proposed split)

1. **Spike: the window and the event stream end to end (macOS).**
   - The `installer/core` schema with only the `plan`, `step`, `log`, `done` and `exit` events.
   - install.sh's `run_step` and `ev` for its 6 top-level steps.
   - The wry/tao crate built locally, showing a minimal page: running state, bar, log and done.
   - The fd 3 / fd 4 process model, close-to-cancel, and the `--dry-run` schema test.
   - Proof: a real install in a fresh macOS user account, with the window from second 0 to Open equin.
   - Also settles the page folder kind and the font choice. *M*
2. **Progress and estimates.** The typed `installStep` on build spans; `progress` events from cargo, the artifact builder, bun install, git clone and softwareupdate; host-grant `wait` events; `estimates.json` and `timing.json`; the interactive and plain terminal renderers (the mockup's terminal view); and the full window port of the running state. *M*
3. **Failures and actions.**
   - The `diagnose` rules (sandbox, security, stall plus the watchdog, unknown) and the login-service `notice`.
   - The pause and decision protocol.
   - Fix with Claude: the prompt, the `.command`, the clipboard path, and the resume FIFO.
   - Report issue and Skip.
   - The Apple-dialog flow and Linux askpass.
   - Every message against the 5 rules; the paused, fixing and done window states pixel-perfect against the mockup.
   - *M–L.* It could be split into 3a (detection and pause) and 3b (Claude, Report, Skip).
4. **Release pipeline and stage 0.** The GitHub Actions workflow (page, macOS universal with ad-hoc signing, 2 Linux builds, `SHA256SUMS`, `release.json`, attestations, one-shot release); the tag-regex check; stage 0 (resolve, download, verify, view choice, `--probe`, fallback); installing the newest release; `--ref`; the binary's self-bootstrap mode, so the notarized app stays additive. Verify with `workflow_dispatch` on `v2026.11.17`, then a real `curl | bash` on a clean Mac and on a Linux VM with and without webkit2gtk. *M*
5. **Docs and entry points** (small). `plugins/installer/CLAUDE.md`, recording the 5 message rules and the protocol; `docs/setup.md`; and the website's install snippet. *S*

Order: 1 first, then 2 and 4 in parallel, then 3, then 5.

## Verification (for the build tasks)

- `./equin test plugins/installer`: the schema, `json_str` escaping, the `--dry-run` stream parsed for every pause kind, and the diagnose rules fed recorded logs (sandbox SIGKILL, Jamf removal, grant stall).
- The window states compared to the mockup with `compare-diff.ts`, by loading the page with recorded event files (a `--replay events.jsonl` flag on the binary, which is also useful for bug reports).
- End to end:
  - a clean macOS user account (`curl | bash`, window, done);
  - the same over SSH (interactive terminal);
  - `CI=1 … | cat` (plain);
  - an Ubuntu 22.04 desktop VM (window), and the same without webkit2gtk (terminal);
  - each failure induced on purpose (run under `sandbox-exec`, `rm` the gateway right after it is built, hold a host grant with a stuck op).

## Decided with the user (2026-11-17, after review)

1. **Optional failures don't block.** The App Management failure is a banner while the build continues, with "Add it now" on the done screen. It replaces the mockup's blocking pause.
2. **Claude app hand-off.** If the app has no supported prefill link, the prompt goes on the clipboard and the window says to paste it. That is accepted.
3. **A fresh install checks out the newest release by default.** `--ref main` keeps the old behaviour.
4. **No release signature, and no branch protection.** You don't want human review in the loop, so `main` and the tags stay unprotected. Trust rests on the checksums plus GitHub's build-provenance records. The notarized app (Backlog) remains the long-term answer for macOS. The note below explains the reasoning.
5. **`equinai/equin` is public,** so the GitHub-hosted macOS and Linux runners are free.

### Note on signing the release (open question 4)

**How hard it is: small, about half a day inside task 4.**

1. **Key pair.** Generate one ECDSA P-256 key pair. The private key goes in an Actions secret; the public key is embedded in stage 0.
2. **Sign.** The release job signs `SHA256SUMS`: `openssl dgst -sha256 -sign key.pem -out SHA256SUMS.sig SHA256SUMS`.
3. **Verify.** Stage 0 runs `openssl dgst -sha256 -verify <embedded pub> -signature SHA256SUMS.sig SHA256SUMS` before trusting any checksum.

P-256 rather than minisign or ed25519 because the `openssl` every Mac ships (LibreSSL 3.3.6) verifies it, and that was checked on this machine. minisign isn't installed, and LibreSSL's ed25519 support is patchy. Most Linux systems have `openssl` too; where it is missing, stage 0 says so and stops.

**Is it the clean thing long term? Not in this form. It mostly repeats a trust we already rely on.**

- **Shared trust root.** The public key would be inside `install.sh`, which is served by the same GitHub. Anyone who can change the release assets can usually change `install.sh` on main too.
- **Same holder.** A key kept in an Actions secret is held by the same CI that builds the binaries.
- **What it would catch:** only someone who can replace release files but cannot push to main. On this repo that is a narrow case.

**What actually adds trust, in order:**

1. **Protect `main` and the `v*` tags on GitHub** (no force-push, required review). It is free, a settings change rather than code, and closes the most likely real attack: a changed `install.sh` or a moved tag.
2. **The provenance records** already in the plan. They bind each binary to this repo's workflow at that tag, and anyone can check them with `gh attestation verify`. They cost nothing and need no key to manage.
3. **The notarized double-click app** (Backlog). There macOS itself checks an Apple-issued Developer ID signature, a trust root outside GitHub. This is the long-term clean answer for macOS.
4. **Only if a separate key is still wanted,** the meaningful version keeps it **offline**: the maintainer signs `SHA256SUMS` locally during `./equin version cut`, and the key is never in CI. That adds a manual step and makes losing the key a real risk.

**Recommendation:** no signature in stage 0 for now. Do 1 now, keep 2 as planned, and treat 3 as the real answer for macOS.

## Spike results (task 1, 2026-11-17)

Landed as `plugins/installer` (`core`: the protocol v1 schema) and `plugins/installer/plugins/window` (`rust/`, `standalone-page/`, `deps/`, `cli/`). Docs: the two plugins' `CLAUDE.md`.

**Settled:**

- **Folder kind: `standalone-page`.** A new leaf folder (`plugin-id`'s `LEAF_FOLDERS`; boundary row `["core"]`; platform APIs forbidden, like `web`). It is bundled into one HTML file before cargo runs, through a new `embed` option on the rust kind's `cargoBuild`: the page's sources, `installer/core` and `bun.lock` are identity inputs, and the file reaches `build.rs` as `EQUIN_INSTALLER_PAGE`. A bare `cargo build` fails loudly without it.
- **Font: the system font.** SF Pro on macOS; the platform's own font on Linux. Nothing is embedded or fetched. The mockup's Inter already falls back to it wherever Inter isn't installed.

**Changed from §2, found while proving it:**

- **The child is the terminal's foreground job.** It still runs in its own process group, but that group is also made the terminal's foreground group. A background group that reads the terminal is stopped by SIGTTIN, so `sudo`'s password prompt would hang. Ctrl-C now reaches the install directly. When the child exits, the window takes the terminal back.
- **Signals use a self-pipe handler, not a blocked mask plus `sigwait`.** macOS starts its dispatch worker threads without the blocked mask. A SIGTERM delivered to one of them killed the window and left the install running.
- **The child starts with default signal dispositions.** An ignored signal survives `exec`, and a window started with `&` from a script has SIGINT ignored.
- **install.sh traps INT, TERM and HUP** when it has an event fd. Without the traps, bash runs its EXIT trap with `$?` = 0, and an interrupted decision read is taken as quit.

**Proven:**

- The `--dry-run` stream is checked against the schema under `/bin/bash` 3.2, through the window's own fd layout. The tests cover:
  - escaping;
  - retry and quit on fd 4;
  - an unknown decision, and EOF;
  - SIGINT while paused, which exits 130.
- The page model has its own tests.
- The real window was run over the dry run:
  - Stopping it while paused or mid-step stops the whole install: the window exits 130 and nothing is left running.
  - A full run exits 0.
  - The terminal prints one line per step.
- The page's running, paused, done and stop states were drawn in a headless browser from the recorded streams.

**Not yet proven:** a real install in a fresh macOS account. That needs a second account and a GUI session in it. It also collides with this machine's own instance, because the gateway's port 9000 is machine-wide. The steps are in the task's report.

## Release pipeline and stage 0 results (task 4, 2026-11-17)

Landed as `.github/workflows/installer-release.yml`, the `installer/release-assets` plugin (the contract and its checks), stage 0 at the top of `install.sh`, and two modes of the binary (`--probe`, self-bootstrap). Docs: `plugins/installer/CLAUDE.md` § Stage 0 and `plugins/installer/plugins/release-assets/CLAUDE.md`.

**Changed from §6–7, found while building it:**

- **A release says whether its script can be handed over.** `v2026.11.17` (the only release so far) predates the window: no crate, and an `install.sh` that knows no `--release`. So the tag's `install.sh` carries a marker line (`# installer-handoff: 1`), the workflow records it as `release.json`'s `handoff`, and stage 0 hands over only to a release that has it. A release without it is installed by main's own steps, on its tag, in the terminal. The workflow still publishes such a tag (install.sh, release.json, SHA256SUMS; no binaries).
- **Two internal arguments, not one.** `--release <tag>` (this script is that release's, verified: never run stage 0 again) and `--checkout <tag|main>` (what the clone checks out), so `--ref main` runs the newest release's script and window but clones main's tip. A fork (`--repo`) installs its own main.
- **The tag grammar is one POSIX ERE** (`RELEASE_TAG_ERE` in upstream/release), the JavaScript regex built from it, so the workflow (bash `=~`) and stage 0 copy one spelling, held equal by `release-assets:tag-grammar`.
- **The toolchain is read from `mise.lock`, not installed by `jdx/mise-action`:** `mise install` would run the repo's postinstall hooks (machine setup and the doctor) on the runner.
- **Published as a draft, then made public in one edit.** `latest` is set only when the tag is the newest release tag, so rebuilding an older tag by hand (`replace`) does not move `releases/latest`.
- **The provenance bundle is a Release file too** (`provenance.intoto.jsonl`), beside the attestations GitHub stores.
- **The checksum tool is `shasum` first.** macOS 14+ ships a BSD `/sbin/sha256sum` that reads no list on stdin; GNU `sha256sum` only where `shasum` is missing.
- **Self-bootstrap downloads with `curl`** (no TLS stack in the binary) and checks with `sha2`. It reports a failure on stderr only: there is no window yet at that point. The double-click app will need that failure drawn in the window.
- **A `publish: false` manual run** builds any ref and keeps the binaries as run artifacts, so the build jobs can be tried without cutting a release.

**Proven locally:**

- The stage-0 test (`release-assets/core/internal/stage0.test.ts`, 13 cases) runs main's `install.sh` piped, as under curl, against a local fake GitHub Releases whose files are written by the workflow's own assembler: newest release, `--ref <tag>`, `--ref main`, a fork, `--window` with the probe passing and failing, SSH / CI / no TTY / `--terminal` (the window binary never downloaded), a changed file and a file SHA256SUMS does not list (stop, deleted, never run), a release without the hand-off, no release at all, a release without a binary for this system.
- `--probe` opens and exits 0 in under a second on macOS; the self-bootstrap reports a missing release loudly.
- `git clone` then `git checkout -B main <tag>` leaves `main` at the tag, tracking `origin/main`.
- `actionlint` passes on the workflow.

**Proven on GitHub Actions (after landing):**

- A manual run on `v2026.11.17` published its Release: `install.sh`, `release.json` (`handoff: null`, no binaries — the tag predates the window), `SHA256SUMS`, `provenance.intoto.jsonl`. `releases/latest/download/release.json` resolves to it; `shasum -c` and `gh attestation verify install.sh -R equinai/equin` pass; a real `curl …/main/install.sh | bash -s -- --stage0-only` reads it and falls back to main's steps on that tag.
- Build-only runs on main: the universal macOS binary builds (`macos-14` is retired; `macos-15`), lipo + ad-hoc sign, `--probe` on the runner's GUI session. Linux x64 / arm64 build; in a bare `ubuntu:22.04` container the binary is refused by the loader (exit 127, "libwebkit2gtk-4.1.so.0: cannot open shared object file"), which is the fallback stage 0 relies on.
- **Found on Linux: a cold font cache.** On a fresh runner the first several WebKit starts never began loading the page (each probe timed out at 20 s, and the real window drew nothing for 30 s: its main thread was blocked), then a probe on the same runner passed. WebKit builds the fontconfig cache on first use, on the UI thread. CI now runs `fc-cache` first. A desktop has a cache already; a machine without one gets the terminal view on its first install (the probe's deadline), with the reason in `probe.log`. The probe's Linux window is also mapped off-screen rather than hidden, since the first diagnosis pointed at the unmapped window and it was never settled whether that alone loads everywhere.
