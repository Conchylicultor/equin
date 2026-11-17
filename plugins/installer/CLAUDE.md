# installer

The equin installer: `install.sh` (repo root — its URL is the documented
entry point) emits ONE structured event stream, and renderers draw it. Design:
[`research/2026-11-17-global-installer-window.md`](../../research/2026-11-17-global-installer-window.md).

## The event stream (protocol v1)

- **One schema**, `core/` (`InstallEvent`, a zod discriminated union): NDJSON,
  one event per line, each with `v: 1`, `t` (ISO-8601 UTC) and `type`. Today:
  `plan` (every top-level step, labelled in the user's words, `est_s` null
  until medians are measured — never a guess), `step` (`start | done |
  skipped | failed`, `ms`), `log` (a step's output, or the script's own with
  `step: null`), `done` (`url`) and `exit` (`code`, written by the EXIT trap).
  `progress`, `action`, `wait`, `notice` and `pause` come with the later tasks.
- **Step ids are a closed set** (`InstallStepId`: tools, mise, clone,
  toolchain, start, build).
- **install.sh writes it by hand** (bash 3.2 — what every Mac ships): `ev`
  (one `printf`, one write), `json_str` (escapes `\ " tab CR ESC`, drops other
  control characters), `run_step <id> <cmd…>` (start → each output line as a
  `log` → done / failed with `ms`), `ev_plan`. With no `--events-fd` every
  `ev*` is a no-op and the install prints to the terminal as before.
- **`run_step` is never a condition.** It always returns 0 and leaves the
  step's status in `STEP_RC` (`run_step x cmd; [ "$STEP_RC" = 0 ] || fail …`).
  Called as `run_step … || fail` or `if run_step …`, bash would ignore `set -e`
  for everything it runs — the step's subshell too, though it sets `-e` again —
  so a command failing mid-body (apt-get, then a line that passes) would read
  as a done step. The dry run fails its step mid-body, so the stream test
  catches a regression.
- **A step's stderr is merged into its stdout** (`2>&1` into one line reader),
  so every step `log` line says `stream: out`; only the script's own stderr,
  read by the window, is `err`. Splitting them is left to a later task.
- **Held to the schema by a test**:
  `window/cli/internal/dry-run-stream.test.ts` runs `install.sh --dry-run`
  under `/bin/bash` and parses every line. `--dry-run` touches nothing; it
  emits every event type, a skipped step and output that needs escaping.
  `EQUIN_INSTALL_DRY_RUN_FAIL=<step>` fails that step's first attempt;
  `EQUIN_INSTALL_DRY_RUN_PACE=<s>` slows it down for watching a renderer.
- **Messages live in the events**: labels and text come from the step engine,
  never from a renderer — the installer message rules
  (`infra/launcher/installer-notice`) are applied in one place.

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

## Sub-plugins

- `window` — the native installer window (`equin-installer`).
- `release-assets` — what a release tag publishes (the GitHub Actions
  workflow, `release.json`, `SHA256SUMS`) and its checks.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The equin installer: install.sh's structured event stream (protocol v1 — plan, step, log, done and exit events, one zod schema in core) and the renderers that draw it. Its window sub-plugin is the native installer window.
- Cross-plugin:
  - Imported by: `installer/release-assets`
- Core:
  - Exports (values):
    - `INSTALL_PROTOCOL_VERSION`
    - `InstallEvent`
    - `InstallMode`
    - `InstallStepId`
    - `parseInstallEventLine`
    - `PlanStep`
- Sub-plugins:
  - **`release-assets`** — What a release tag publishes for the curl install: the GitHub Actions workflow (.github/workflows/installer-release.yml) that builds the installer window per release tag, the asset names and…
  - **`window`** — The installer window: equin-installer, a small wry/tao Rust app (rust/) that runs install.sh as its child — events on fd 3, decisions on fd 4 — and draws the stream in a page bundled into the binary…

<!-- AUTOGENERATED:END -->
