# tab-memory

Where a browser tab's memory goes beyond the JS heap. Findings and method:
[`research/2026-11-11-global-browser-tab-memory.md`](../../../../../../research/2026-11-11-global-browser-tab-memory.md).
For what a repeated flow leaves on the JS heap (three snapshots, survivors,
retainer paths) use the harness's `leak-test.ts` — this plugin covers the rest.

## Telemetry: which tab, app and route is growing

The machine watcher sees "a Chrome renderer"; the page is the only one that
knows what it holds. So every top-level page the user drives (not an embedded
document, not one under automation) samples itself 30 s after load and every
5 minutes after (`web/components/tab-memory-recorder.tsx`), and posts it to
its own server, which appends it to the durable `tab-memory` log of that
worktree (`~/.equin/worktrees/<wt>/logs/tab-memory.jsonl`). A sample
(`core/internal/sample.ts`): the page (`getTabId()` + `performance.timeOrigin`,
so a reload is a new page), host, route, focused app, visibility, JS heap,
DOM nodes, canvas backing stores, decoded images, iframes, media, and every
open in-app tab of every mounted tab set (`peekTabSets()` from
`apps-core/tabs`) — each one mounted, keep-alive, so held in memory.

Main's `health-owners` log (machine-usage's owner sampler) names each of the
largest processes with its **pid**, so one renderer is one series. A page
cannot learn its renderer's pid; the two are joined **by time**.

**Debug → Tab memory** (`tab-memory.series`, last 12 h): the Chrome renderers'
footprint per pid, each page's JS heap on the same axis, and a DataView of the
pages (route, worktree, focused app, in-app tabs held, JS heap and its growth
per hour, DOM nodes first → now, canvas + image MB, age). Reading a climb:

1. Find the climbing pid in the first chart and its window.
2. The page whose JS heap (or, in the table, DOM nodes / canvas + images)
   climbs over the same window is it. Selecting a row highlights its line and
   lists the in-app tabs it holds.
3. If no page's figures climb, the growth is native (decoded audio, GPU
   tiles, the inspector…): the pages alive and sampling through the window
   are the candidates, and their in-app tabs say what they held mounted.

**`performance.memory` is coarse**: Chrome buckets it and refreshes it about
every 20 minutes without `--enable-precise-memory-info` (a 160 MB allocation
left it unchanged, 2026-11-12). Fine for an hours-long climb, useless at
minute scale. `measureUserAgentSpecificMemory()` (exact, per frame) needs
cross-origin isolation, which the app does not have. Design:
[`research/2026-11-12-global-tab-memory-telemetry.md`](../../../../../../research/2026-11-12-global-tab-memory-telemetry.md).

## Climb watch: a climbing tab files a report

Nobody watches the pane, so main's `debug.tab-memory-climb` job
(`server/internal/climb-job.ts`, every 10 min, main only) judges every Chrome
renderer of the user's Chrome (`isChromeRenderer`: `… (Renderer)` and
`… (Aperitif Renderer)`) from the last 6 h of `health-owners`, and files a
**`tab-memory-climb`** report (variant `error`, fingerprint per pid) for each
one past the bar (`server/internal/detect.ts`, pure, tested):

- **Floor, not reading**: a renderer's level is its lowest footprint over the
  last 30 minutes — a GC sawtooth (1+ GB swings within 20 minutes measured)
  reaches its trough inside it, so a peak never reads as the level.
- **`high`**: floor ≥ 3000 MB. **`climbing`**: floor ≥ 2500 MB and ≥ 1000 MB
  above the lowest reading of the 3 h before (with ≥ 1 h of history). Bars
  are config (`tab-memory-climb` in Settings → Config). Calibrated on
  2026-11-06 → 11-12: the replay names all four climbs (to 3.3–10.7 GB) and
  nothing in between (normal floors 0.6–1.9 GB, peaks to 2.4 GB).
- **Attribution by time**: the pages that sampled themselves through the
  window (from the baseline to now), open ones first, then by JS heap +
  canvas/images growth — each with host, route, app, visibility, figures at
  the window's start and now, and its in-app tabs. **What grew**
  (`growth`): `js-heap` / `canvas-images` (a page's figure explains ≥ ⅓ of
  the climb), `dom` (≥ 10,000 more nodes, ≥ 1.5×), `native` (pages sampled,
  none explain it), `unattributed` (no page sampled).

The report re-files every tick while the renderer stays past the bar, so its
count reaches the Report investigations automation's recurrence bar (3)
within ~30 minutes; it is `error`, so the default severity scope takes it.
The bell re-rings at most every 6 h.

## Measurement scripts

- **`e2e/clean-soak.ts`** — the tab's native memory, measured with nothing
  attached to the page. It spawns `chrome-headless-shell` itself and talks CDP
  only to the browser target: a `memory-infra` dump per renderer (private
  footprint; v8, malloc, partition_alloc and its partitions, blink_gc,
  web_cache …) every `--every` seconds, or after each round of `--paths`
  (in-app navigation through `Runtime.evaluate` on a flat page session, no
  domain enabled). With `--tabs`, each `--paths` entry opens in its own in-app
  tab (dump after each), then `--rounds` cycles focus through every tab — the
  cost of a session's accumulated tabs:

  ```bash
  ./equin run plugins/debug/plugins/profiling/plugins/tab-memory/e2e/clean-soak.ts \
    --urls http://<ns>.localhost:9000/agents --tabs --paths /sonata,/agents/c/<id>,… \
    --rounds 2 --dwell 5000 --out "$EQUIN_SCRATCH/tabs"
  ```

  ```bash
  ./equin run plugins/debug/plugins/profiling/plugins/tab-memory/e2e/clean-soak.ts \
    --urls http://equin.localhost:9000/agents --minutes 30 --every 120 --out "$EQUIN_SCRATCH/clean"
  ```

  **Why not Playwright**: Playwright enables `Network` and `Runtime` on every
  page it drives, so the inspector keeps response bodies (the `buffer`
  partition after a few navigation rounds: 251 MB vs ~15 MB) and console
  arguments, and a heap snapshot
  leaves 150–200 MB of malloc behind. Native numbers read through it grow
  when the app does not.

- **`e2e/listener-probe.ts`** — which event listeners a tab accumulates and
  who adds them: wraps `EventTarget.prototype.add/removeEventListener` before
  boot, counts live registrations per (target type, event type) and reports
  the net growth over `--minutes` with the adding stacks.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Tab memory telemetry, browser half: every top-level page the user drives samples itself (JS heap, DOM nodes, canvases, images, its open in-app tabs and route) 30 s after load and every 5 minutes after, posted to its own server; Debug → Tab memory draws each page beside each Chrome renderer's footprint (by pid) over the last 12 h, with a DataView of the pages; registers the climb watch's bars (tab-memory-climb) for Settings → Config. Tab memory telemetry, server half: logs each page's sample to the durable tab-memory channel of the worktree it talks to, and serves tab-memory.series — every worktree's pages over the last 12 h beside each Chrome renderer's footprint (by pid) from main's health-owners log. The climb watch: every 10 minutes on main, a Chrome renderer whose memory floor is too large or climbing files a tab-memory-climb report (error) with its growth curve, the pages alive through its window and what grew.
- Web:
  - Slots: `tabMemoryPane.Actions`
  - Slot contributors: `tabMemoryPane.Actions` ← `primitives.pane`
  - Contributes:
    - `ConfigV2.WebRegister` "tab-memory-climb"
    - `Core.Root` → `TabMemoryRecorder`
    - `Pane.Register` "debug-tab-memory"
    - `DebugApp.Sidebar` "Tab memory"
  - Uses: 29 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `stats/commits` ×7
    - `primitives/pane` ×4
    - `primitives/data-view` ×3
    - `infra/endpoints` ×2
    - `primitives/css/spacing` ×2
    - `primitives/css/text` ×2
    - `apps-core/tabs.peekTabSets`
    - `apps/debug/shell.DebugApp`
    - `config_v2.ConfigV2`
    - `network/live/live-state.ResourceErrorInline`
    - `network/live.useLive`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/networking/page-transport.pageTransport`
    - `primitives/relative-time.RelativeTime`
    - `primitives/scope/tab-id.getTabId`
  - Exports (values): `tabMemoryPane`
- Server:
  - Contributes:
    - `resource.declare` "tab-memory.series"
    - `ConfigV2.Register` "tab-memory-climb"
    - `report-kind` "tab-memory-climb"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `infra/endpoints.implement`
    - `infra/file-watcher.acquireDirWatch`
    - `infra/jobs.defineJob`
    - `infra/paths.listWorktreeDirsAsync`
    - `infra/paths.worktreesDir`
    - `network/live.serveValue`
    - `primitives/log-channels.defineLogSink`
    - `primitives/log-channels/log-files.readChannelJson`
    - `reports.ReportKind`
    - `reports.ReportRow`
    - `reports/engine.recordReport`
  - Register: `defineJob('debug.tab-memory-climb')`
  - Resources: `tab-memory.series` (push, notified, capped: MAX_PAGES, capped: MAX_RENDERERS, capped: MAX_PAGE_POINTS, capped: MAX_RENDERER_POINTS, capped: MAX_IN_APP_TABS)
  - Routes: `POST /api/tab-memory/sample`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/bool/config.boolField`
    - `fields/int/config.intField`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `packages/list-bound.cappedList`
  - Exports (types):
    - `ClimbPage`
    - `InAppTab`
    - `PagePoint`
    - `PageSeries`
    - `RendererSeries`
    - `TabMemoryClimb`
    - `TabMemoryData`
    - `TabMemoryGrowth`
    - `TabMemorySample`
  - Exports (values):
    - `CLIMB_CURVE_BIN_MS`
    - `CLIMB_CURVE_MS`
    - `ClimbPageSchema`
    - `InAppTabSchema`
    - `jsHeapGrowthMbPerHour`
    - `MAX_CLIMB_CURVE_POINTS`
    - `MAX_CLIMB_PAGE_TABS`
    - `MAX_CLIMB_PAGES`
    - `MAX_IN_APP_TABS`
    - `MAX_PAGE_POINTS`
    - `MAX_PAGES`
    - `MAX_RENDERER_POINTS`
    - `MAX_RENDERERS`
    - `RENDERER_BUCKET_MS`
    - `submitTabMemorySample`
    - `TAB_MEMORY_CLIMB_KIND`
    - `TAB_MEMORY_FIRST_SAMPLE_MS`
    - `TAB_MEMORY_GROWTH`
    - `TAB_MEMORY_SAMPLE_EVERY_MS`
    - `TAB_MEMORY_WINDOW_MS`
    - `tabMemoryClimbConfig`
    - `TabMemoryClimbSchema`
    - `TabMemoryDataSchema`
    - `TabMemorySampleSchema`
    - `tabMemorySeries`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
- Exemptions:
  - Exempts itself from:
    - `no-raw-websocket` — `e2e/clean-soak.ts` (sanctioned)
    - `networking/no-page-transport` — `web/components/tab-memory-recorder.tsx` (sanctioned)

<!-- AUTOGENERATED:END -->
