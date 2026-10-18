# Browser recordings v2 — full-resolution frames, no trace, e2e + browser_* MCP

Follows `2026-10-17-global-e2e-recordings.md` (unmerged; this reshapes it before it lands).

## Context

v1 records every e2e run through Playwright tracing and shows a filmstrip under
the Bash call. Feedback:

- The frames are 800 px JPEGs (tracing's screencast is hardcoded to fit 800×800,
  q90 — no option), so text is blurry when opened.
- The 9.5 MB `ctx0.zip` per run (DOM snapshots, for `playwright show-trace`) is
  data nobody will ever open. Drop it.
- The `browser_*` MCP tools (infra/mcp/browser) drive a browser too, and nothing
  records them. One recording path should serve both: each MCP call shows its
  frame under its own tool call, exactly like an e2e run's strip.

Outcome: one recording store (`<toolUseId>/<runId>/{manifest.json, frames/*.png}`),
full-resolution PNG per step, written by the e2e harness and by the browser MCP
tools alike, rendered by one footer under any tool call.

## Design

### 1. One plugin, renamed: `debug/e2e-recordings` → `debug/browser-recordings`

It is no longer e2e-only (unmerged, so the rename is free; `./singularity plugin
move`). Data dir `browser-recordings`, same layout, `frames/` now PNG.

- `core/` (browser-safe; web imports it): manifest schema (drop `traceZip`;
  context → `source: {kind:"e2e", script} | {kind:"mcp", tool}`), `browserRecordingRuns`
  live value (params `toolUseId`), `isRecordedToolCall(event)` (the one matcher:
  Bash running `singularity run …/e2e/…`, or `mcp__*__browser_*`).
- `plugins/writer/core/` (new child, node-only so the web bundle never pulls
  `node:fs`): `openRecording({ toolUseId, source }) → { step({title, startMs,
  durationMs, error?, png}), close() }`. Writes `frames/<n>.png` (consecutive
  identical frames — same sha1 — share one file), writes `manifest.json` last
  (the live value's watch keys on it), prunes to the newest 200 runs. Both
  producers go through it — this IS the unified path.
- `server/`: the live value, unchanged (shared dir watch, push).
- `web/`: `RunStrip` (unchanged look), the footer component, the Artifacts kind
  (extract now uses `isRecordedToolCall`).
- Delete `parseTraceSteps` + its test (no trace any more).

### 2. Producer A — e2e harness (no tracing)

`e2e-harness/e2e/recorder.ts`, rewritten:

- **Steps**: `chromium._instrumentation.addListener({ onApiCallBegin, onApiCallEnd })`
  — Playwright's client instrumentation (private; verified in 1.62.1, not in the
  `.d.ts`). `onApiCallEnd(zone)` gives `apiName`/`title`, `error`; skip
  `zone.internal`, `cdpSession.*`, `page.screenshot`, `tracing.*`, `route.*`
  (the harness's header route — same filter as v1's `NOT_STEPS`). Asserted at
  startup: a Playwright upgrade that removes it fails the run loudly, never
  silently records nothing.
- **Frames**: per page, a CDP session with `Page.startScreencast({ format: "png",
  maxWidth/maxHeight: viewport × DPR })` (ack every frame). Full resolution.
  The recorder holds only the latest frame in memory; at a step's end it takes
  that frame, and any frame arriving within 300 ms (the v1 grace) replaces it.
  So the frame is the last paint at the step's end — deterministic, no
  `page.screenshot()` racing the next action, nothing awaited in the script's
  path. (A `page.screenshot()` from the listener is not awaited by Playwright
  and would capture a later state.)
- No `tracesDir`, no zip. Teardown: stop screencasts, `close()` the writer.
  `--no-record` unchanged.

### 3. Producer B — browser_* MCP tools

- **Link**: Claude Code sends `_meta["claudecode/toolUseId"]` on every MCP
  `tools/call` (found in the 2.1.302 binary). `infra/mcp/server`'s `mountTool`
  reads the SDK's `extra._meta` into `McpToolContext.toolUseId: string | null`
  (validated with `TOOL_USE_ID_RE`). Generic — any MCP tool can use it.
- **Capture**: in `browser/server/internal/tools.ts` `forward()`, after a
  page-changing tool (navigate, act, batch, javascript, viewport, tabs — a
  `records: true` flag on the spec in `shared/tools.ts`, so a new tool decides
  explicitly) returns, the backend calls the host's existing `screenshot` tool
  (viewport, PNG) and writes a one-step recording (title = tool + its short
  args, e.g. `act click "Artifacts"`; error = the call's error). Done in the
  backend, not the host: no `HOST_PROTOCOL` bump (a worktree can't replace
  main's running host, so a host change would be untestable before merge), and
  the backend already owns the conversation and the data dir. Cost: one
  screenshot round-trip (~100–200 ms) per page-changing call.
- `browser_screenshot` itself is not re-recorded (the agent already has it).
  Per-action frames inside one `browser_batch`: later, if wanted (needs the host).

### 4. Rendering — one footer for any tool call

- Replace the bash-only `BashTool.Footer` (unmerged) with a generic
  `JsonlViewerTool.Footer` render slot in the tool-call plugin, rendered by
  `ToolCallRow` under the dispatched renderer for every tool. Props: `{ event }`.
- Recordings contributes one footer: `isRecordedToolCall(event)` → `useLive(
  browserRecordingRuns, { toolUseId })` → loading / error / `RunStrip`s; nothing
  when the (loaded) list is empty. No `running` gate: the value is pushed, so a
  strip appears when the manifest lands.
- Strip caption: `Recording · <script> · N steps` (e2e) / no caption for a
  one-step MCP frame (just the thumbnail, title on hover/viewer).

## Cost (expected; measured in verification)

- Disk: PNG of a 1400×900 app view ~150–400 KB; ~10 distinct frames per e2e run
  → ~2–4 MB, down from ~10 MB. MCP: one frame per page-changing call.
- e2e time: no teardown zip (was ~0.9 s). Chromium PNG-encodes each painted
  frame during the run — measure; if it slows runs, switch the screencast to
  JPEG q90 at full resolution (still sharp, ~5× smaller).

## Critical files

- `plugins/debug/plugins/e2e-recordings/**` → `plugins/debug/plugins/browser-recordings/**` (+ `plugins/writer/`)
- `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/{recorder.ts,browser.ts}`
- `plugins/infra/plugins/mcp/server/internal/{mcp.ts,handle-mcp.ts}` (`toolUseId` in context)
- `plugins/infra/plugins/mcp/plugins/browser/{shared/tools.ts,server/internal/tools.ts}`
- `plugins/conversations/.../jsonl-viewer/plugins/tool-call/web/{slots.ts,components/tool-call-row.tsx}`; bash plugin loses its footer slot
- `config/conversations/conversation-view/artifacts/kind.jsonc` (kind id rename)

## Verification

- `./singularity test plugins/debug/plugins/browser-recordings` (writer: dedupe,
  manifest last; matcher).
- Build; run `screenshot.ts --click "Artifacts"` from this conversation: PNG
  frames at 1400×900 on disk, no zip, run size, run time vs `--no-record`.
- MCP side: this conversation's `browser_*` tools are served by **main**
  (`SINGULARITY_PARENT_HOST=singularity`), so they only record after merge.
  Before that: a scripted JSON-RPC `tools/call` (`browser_navigate`, then
  `browser_act`) with `_meta: {"claudecode/toolUseId": …}` against this
  worktree's `/api/mcp/<conv>` — frames land under that id; a handle-mcp unit
  test pins `_meta` → `ctx.toolUseId`. The live check under real tool calls
  happens on main after push.
- `strip-verify.ts` updated to check both kinds.

## As landed (2026-10-18)

- Steps: Playwright's instrumentation reports the harness's own callbacks
  (route handlers) with no `apiName`; those, and the `Route` /
  `WebSocketRoute` / `CDPSession` classes, are not steps (1900 → ~20 a run).
- Manifest flattened: `steps` directly (instrumentation is per connection, not
  per context); a step's frame is the last paint across the run's pages.
- Measured on `screenshot.ts --click Artifacts` (machine load avg 15–30):
  19–22 steps, 12–15 distinct 1400×900 PNG frames, **2.1 MB** a run (v1:
  ~10 MB), writing it 21 ms (2.5 s once under load). Wall time too noisy to
  attribute (rec 33 s / 167 s vs no-rec 23 s / 48 s); one recorded run hit a
  `screenshot` timeout the no-rec runs did not — watch for PNG-encoding cost,
  fallback is a full-resolution JPEG screencast.
- MCP: a scripted `browser_navigate` with `_meta` recorded its frame; a
  `browser_act` whose screenshot timed out (machine load) answered with the
  recording failure appended, the call itself intact.
