# window

`equin-installer`: a small wry + tao Rust app (`rust/`, not Tauri — one page,
one window, one child needs no config, ACL or capabilities; the same wry/tao
releases as the menu-bar helper) that runs `install.sh` as its child and draws
its event stream ([`../../CLAUDE.md`](../../CLAUDE.md)).

```bash
./equin installer window [--pace 0.4] [--fail clone[:sigkill|:vanish|:quiet]] [--notice]   # over a DRY RUN
./equin deps install installer-window --json          # just build it; prints where
<dir>/equin-installer --script <install.sh> [-- <install.sh args…>]
<dir>/equin-installer [--ref <tag>] [-- <install.sh args…>]  # self-bootstrap
<dir>/equin-installer --probe                          # can a window show here?
```

- **`--probe`** (`rust/src/probe.rs`): opens a hidden window and webview,
  loads the page, exits 0 when the page says `ready` (20 s deadline; no Dock
  icon). Stage 0 runs it before choosing the window, release CI as its smoke
  test. On Linux without webkit2gtk-4.1 the loader refuses the binary before
  `main`, so the probe fails without running.
- **Self-bootstrap** (`rust/src/bootstrap.rs`): with no `--script`, the binary
  does stage 0's fetch itself — `release.json` (newest, or `--ref`),
  `SHA256SUMS`, `install.sh`, each sha256-checked (`sha2`) — and runs that
  script with `--release <tag> --checkout <tag>`. That is what lets a
  notarized double-click app wrap this same binary with no shell around it.
  Downloads go through `curl`; `EQUIN_RELEASES_URL` overrides the source.
  A failure is printed on stderr (no window yet).
- **Release builds**: `.github/workflows/installer-release.yml`
  ([`release-assets`](../release-assets/CLAUDE.md)) bundles the page with
  `scripts/bundle-page.ts` and builds the crate per release tag (universal
  macOS ad-hoc signed, Linux x64 / arm64).

`./equin installer window` only ever runs a dry run: `install.sh` run from a
checkout installs THAT checkout, which on a developer's machine would
re-register the running gateway from a worktree. A real install runs the
binary through the curl stage 0 (`install.sh`), or directly.

## Process model (`rust/src/child.rs`)

- **Events on fd 3, decisions on fd 4.** Two pipes, every end close-on-exec
  and above fd 10, moved onto the child's 3 and 4 just before exec. install.sh
  closes both for every step's commands, so a daemon a step starts never holds
  the event pipe.
- **The child is its own process group, and the terminal's foreground job**
  (when the window was started from a terminal it held): `sudo` can read a
  password, and Ctrl-C in the terminal reaches the install. When the child
  exits the window takes the terminal back (SIGTTOU is ignored for that).
- **Signals sent to the window** (INT, TERM, HUP) run a handler that writes
  to a self-pipe; one thread turns them into events, which stop the install
  (SIGINT to its group) and the window exits with the script's code. Not a
  blocked mask + `sigwait`: macOS starts its dispatch worker threads without
  the mask, a SIGTERM landed on one, killed the window and left the install
  running. SIGTTOU is ignored (to take the terminal back from the
  background); the child starts with INT, QUIT, TERM, HUP and TTOU at their
  defaults — an ignored signal survives exec, and a window started with `&`
  from a script has SIGINT ignored.
- **install.sh traps INT / TERM / HUP** (`exit 130 / 143 / 129`), in every
  mode: otherwise bash runs its EXIT trap with `$?` = 0 before dying of
  the signal, and a decision read cut by one would be taken as quit.
- **Closing the window mid-install** asks "Stop installing?" in the page;
  Stop sends SIGINT to the group. A child that exits 130 (Ctrl-C, Stop) closes
  the window. Otherwise the window stays on its done / stopped screen until
  closed or Open equin, and exits with the script's code.
- **The window writes events too**: each line of the script's own stdout /
  stderr becomes a `log` event with `step: null`, and an `exit` event when the
  script died before its EXIT trap could write one. All of them go through the
  same backlog, read after the event pipe's EOF.
- **The terminal** gets one plain line per step, plus the done URL.

## The page (`standalone-page/`)

- **A `standalone-page/` folder** — a leaf folder kind (`plugin-id`'s
  `LEAF_FOLDERS`): a page no app serves, bundled into ONE self-contained HTML
  file a native shell compiles in. Its boundary row reaches `core` only, and
  like `web` it may import no platform API.
- **Bundled before cargo** by the dependency's build (`deps/internal/page.ts`:
  `Bun.build` of `main.ts`, inlined at the HTML's `<script>/*BUNDLE*/</script>`
  slot), through `cargoBuild`'s `embed` (the rust kind): the page's sources,
  `installer/core` and `bun.lock` are identity inputs, the file is handed to
  `build.rs` as `EQUIN_INSTALLER_PAGE`, and a bare `cargo build` fails loudly
  without it. Served from `installer://app/`; nothing is fetched.
- **A pure function of the events and the clock**: `model.ts` folds each
  line (parsed against the schema — a line outside it is a loud
  protocol-error screen, never skipped); every time-dependent read takes
  `now`, so a reload asks for the backlog (`ready`) and lands on the same
  screen. Commands back are a closed set (`ready retry quit skip fix-app
  fix-cli show-claude add-services stop open-equin open-url password
  password-cancel close drag`), refused by Rust otherwise; the decisions are
  written to fd 4. Open equin opens only the `done` event's URL; `open-url`
  only a `https://github.com/` link (Report issue) or App Management.
- **Paused / fixing / done** (the mockup's, pixel for pixel — `moment.ts`
  writes each mockup moment; 0 differing pixels for the failed states and
  done, the fixing card differs only in its sentence, which says the prompt
  is on the clipboard): "Installation paused" (a stall: "Still waiting"),
  Fix with Claude (split button; where it opens is the page's choice, else
  the last `fixing` event's — the page stores nothing), Report issue
  (`installIssueUrl`), the bar paused, and the diagnosis box until Show log.
  An `unknown` pause leads with Try again. Fixing: "Claude is working on it",
  Show Claude, Try again (not for a stall: its step still runs). A `notice`
  is a banner while the install runs (Open App Management, Skip) and "Add it
  now" on the done screen.
- **Closing after the done** writes `quit` (the script may wait on Add it
  now) and exits 0.
- **sudo's password** (`rust/src/askpass.rs`, Linux): the window listens on a
  socket in a 0700 temp dir (`EQUIN_INSTALLER_ASKPASS`, with its own path in
  `EQUIN_INSTALLER_BIN`); `equin-installer --askpass <prompt>` connects,
  sends the prompt, prints the answer for sudo. The page's password sheet
  answers (`password` / `password-cancel`); nothing is written anywhere.
- **Running state** (the mockup's, pixel for pixel): the status line is what
  runs now — the running sub-step, else its step — as `<doing> · <done> of
  <total>` when the tool gave a count (`progress`), else `<doing>…`; an open
  `wait` says what it waits for instead (no internal names). The caption is
  `Step N of G` over the plan's **groups**, then the time left.
- **Time** (`model.ts`, tested): steps with sub-steps are timed by their
  sub-steps. Worked time comes from `ms` / `t`, minus any wait. Pace = Σ
  worked / Σ estimate over finished estimated steps (1 before any).
  Remaining = Σ pending `est × pace` + the running one's `max(0, est × pace −
  worked)`, so a wait holds it still. **Any step left with `est_s: null` → no
  time shown at all** and the bar moves by finished steps (sub-steps as
  fractions of theirs); otherwise the bar is worked / (worked + remaining).
- **A 1 s display clock** redraws the running state in place (the data only
  changes on a push, but the time left and a wait's "started N min ago" are
  text, which a CSS transition cannot move).
- **The log follows its end with `column-reverse`** (a short one held at the
  top by an auto margin): the page writes no scroll position.
- **Font: the system's** (SF Pro on macOS). No web font to embed or fetch; the
  mockup's Inter falls back to the system font wherever Inter isn't installed.
- Ported from the approved mockup's window view (`proto-1794832268-wlybzk`):
  running, paused, fixing, stopped, done (Open equin), and the stop sheet.

## Replaying a stream (`e2e/`)

```bash
./equin run plugins/installer/plugins/window/e2e/moment.ts --out "$EQUIN_SCRATCH/m.jsonl" \
  [--state running|failed|fixing|done] [--failure sandbox|security|stall] [--claude app|cli]
./equin run plugins/installer/plugins/window/e2e/replay.ts --url http://equin.localhost:9000 \
  --events "$EQUIN_SCRATCH/m.jsonl" --now <iso it printed> --out "$EQUIN_SCRATCH/replay" \
  [--mockup "<prototype url>?view=window&state=failed&failure=security"] [--threshold 0.1] [--mockup-own-font]
./equin run plugins/installer/plugins/window/e2e/password-sheet.ts --url http://equin.localhost:9000 --out "$EQUIN_SCRATCH/password"
```

The prototype URL is its content host's:
`http://proto-1794832268-wlybzk.content.localhost:9000/equin/api/prototypes/proto-1794832268-wlybzk/index.html`.

`replay.ts` bundles the page (`deps`' `bundlePage`), draws any recorded
stream at 760 × 640 with its clock pinned to `--now`, and screenshots it; with
`--mockup` it also captures the mockup's window (its fake traffic lights,
corners and shadow hidden; its font set to the page's) and diffs the two.
`moment.ts` writes one of the mockup's moments as events (the mockup's own
strings, medians, failures and log lines).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The installer window: equin-installer, a small wry/tao Rust app (rust/) that runs install.sh as its child — events on fd 3, decisions on fd 4 — and draws the stream in a page bundled into the binary (standalone-page/). Built locally as the installer-window dependency; `./equin installer window` runs it over this checkout's install.sh.
- Cli:
  - Uses: `infra/jobs/supervised-job.cliExecContext`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps/rust.cargoBuild`
  - Exports (values):
    - `bundlePage`
    - `installerWindow`
- Exemptions:
  - Exempts itself from:
    - `scroll-safety/no-scrolling-focus` — `standalone-page/main.ts` (sanctioned)
    - `paths:no-hardcoded-paths` — `e2e/moment.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
