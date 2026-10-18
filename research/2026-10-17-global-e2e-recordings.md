# E2E recordings — every headless run recorded, shown under its tool call

## Context

Claude-in-Chrome can record a GIF of a browser session. Our verification path is
headless Playwright through the e2e harness, and it leaves nothing to look at
except the `-before.png` / `-after.png` a script chose to snap. The user wants
every e2e / browser script run recorded **automatically** — its steps detected
without the script doing anything — and the recording **linked to the Bash tool
call** that ran it in the conversation view.

## Design

### 1. Capture — in the harness, zero script changes

Every script opens its browser through `withBrowser` / `harness.session()`
(`e2e-harness/e2e/browser.ts`), so that is the only place to change.

- `launchChromium(…, { tracesDir: <run>/trace })` and
  `context.tracing.start({ name: "<label>", screenshots: true, snapshots: true })`
  right after `newContext` in `session()`. Playwright streams the live trace as
  plain files into `tracesDir` (`<name>.trace` JSONL + `resources/<sha1>`): every
  action is a `before`/`after` pair with its title, and the screencast frames are
  JPEGs on disk. **Steps are detected by Playwright itself** — goto, click, fill,
  waitFor… — no instrumentation.
- At the top of the `teardown` already registered via `onBeforeFinish` (before
  `browser.close()`): `tracing.stop({ path: <run>/trace.zip })` per context (for
  `playwright show-trace`), then build `manifest.json` from the raw trace.
  A recording failure is reported as a harness FAIL line (like any teardown
  error) — never swallowed.
- Route plumbing (`Route.continue`, one per request from the harness's own
  header-stripping route) is not a step — 1463 of 1470 "steps" on the first run.
- `--no-record` opts out (profilers). Video: deferred (needs Playwright's ffmpeg;
  the frames in the image viewer's slideshow already play a run back).

### 2. Data model (new plugin `e2e-harness/plugins/recordings`)

- `data-dirs/`: `defineDataDir({ kind: "logs", name: "e2e-recordings", reclaim: { kind: "ttl", ttlDays: 14 } })`.
  Layout: `<root>/<toolUseId | "manual">/<runId>/{manifest.json, trace/…, trace.zip, video/*.webm}`.
- `core/`:
  - `E2E_TOOL_USE_ID_ENV = "SINGULARITY_TOOL_USE_ID"`.
  - `RecordingManifestSchema` (zod): script, startedAt, endedAt, verdict?, contexts →
    steps `{ title, startMs, endMs, error?, frame? }` (frame = absolute path of
    the last screencast frame at/before the step's end), video?, traceZip.
  - `parseTraceSteps(traceJsonl, resourcesDir)` — pure, unit-tested.
  - `e2eRecordingRuns` live value (`params: ["toolUseId"]`) →
    `{ runs: (manifest & { dir })[] }` (an endpoint read is lint-banned).
- `server/`: `serveValue`, external + notified — lists
  `<root>/<toolUseId>/*/manifest.json`; `whileSubscribed` rides ONE shared
  `acquireDirWatch` on the recordings root and notifies the tuple whose
  manifest landed (pushed, so a background run's strip appears when it ends).
- The `Recorder` itself lives in `e2e-harness/e2e/recorder.ts` (the plugin's
  own `e2e/` holds a verify script that imports the harness — a cycle otherwise).
- `web/`: `<E2eRecordingStrip>` — a horizontal filmstrip of step thumbnails
  (image-viewer `ImageGallery` + `ViewerThumbnail`, served by host-fs raw, which
  serves any absolute path with range support), step title under each, the
  failing step tinted, a video player when present, and the show-trace command.

### 3. Linking a run to its Bash tool call

- The PreToolUse payload carries `tool_use_id` (question-relay already reads it).
  `guards/core/runner.ts` threads it into `GuardContext.toolUseId`.
- `TOOL_USE_ID_ENV` / `toolUseIdFrom` live in guards core (the hook runs under
  bare bun — it cannot import the recordings core, which pulls zod).
- New guard `e2e-tool-use-id`: a Bash command that calls `singularity run`
  is rewritten to `export SINGULARITY_TOOL_USE_ID=<id>; <command>` (export, so a
  chain `a && ./singularity run …` still sees it). Applies to foreground and
  background calls; the transcript keeps the model's original command.
- `./singularity run` passes env through to the script (already does). The
  harness reads the env var; absent (a human run) → `manual/`.
- The harness prints `recording: <dir> (N steps)` so the agent also sees it.

### 4. Rendering under the tool call

- The Bash renderer has no extension point and the dispatch slot is single-match,
  so the bash tool-call plugin gains a `BashTool.Footer` render slot
  (`{ event }`), rendered under the body in both the plain and background card.
- The recordings web contributes to it: fetch the endpoint with `useEndpoint`
  keyed on `event.toolUseId` + the result/notification instant (push: the
  transcript arriving IS the change signal — no polling); nothing rendered when
  there are no runs.

## Critical files

- `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/browser.ts`
- `plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/recordings/**` (new)
- `plugins/framework/plugins/tooling/plugins/guards/core/{runner.ts,types.ts,index.ts,guards/e2e-tool-use-id.ts}`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/bash/web/**`

## Follow-ups (not in this change)

- Recordings as a `ConversationArtifacts.Kind`.
- Host the Playwright trace viewer in-app ("Open trace").

## Verification

- `./singularity test` on the recordings plugin (`parseTraceSteps`) and guards.
- Build, then run `screenshot.ts --click …` from this conversation: confirm
  `recording:` line, manifest on disk, and the filmstrip under that Bash call in
  the conversation view (screenshot of this conversation's pane).
