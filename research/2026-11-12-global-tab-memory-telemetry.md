# Tab-side memory telemetry

Task: `task-1794377779-w0zmm1` (follow-up of
[`2026-11-11-global-browser-tab-memory.md`](2026-11-11-global-browser-tab-memory.md),
§ *What explains 12 GiB*).

## Context

On 2026-11-10 one Chrome renderer went 3.3 → 10.75 GB at ~1.4 GB/h. Main's
`health-owners` log saw it only as "Google Chrome Helper (Renderer)" — no pid,
and the app records nothing about its own tabs. So the ramp could not be tied
to a browser tab, app or route after the fact, and it did not reproduce on
demand. The missing signal: **which page grows, and what it had open, when.**

## What a page can measure (checked in Chromium, 2026-11-12)

- `performance.measureUserAgentSpecificMemory()` — needs cross-origin
  isolation; the app is not isolated (`crossOriginIsolated === false`). Not
  available.
- `performance.memory` — available, but **bucketed and cached**: a 160 MB
  allocation did not move `usedJSHeapSize` (148,000,000 before and after).
  Chrome refreshes it about every 20 minutes. Enough for an hours-long ramp
  (1.4 GB/h is ~470 MB per refresh), useless for minute-scale changes. Kept,
  documented as coarse.
- Exact and cheap: DOM node count, `<canvas>` backing stores (w × h × 4),
  decoded `<img>` pixels, iframes, `<video>/<audio>` elements, and — from the
  app — every open in-app tab (app + route), the focused route, visibility,
  page age.

A page cannot learn its renderer's pid. The link to the process is therefore
**by time**: the machine side gains the renderer's pid, and one pane draws
each renderer's footprint and each page's figures on one time axis.

## Design

### 1. Each page samples itself — `debug/profiling/tab-memory` web

`TabMemoryRecorder` (headless, `Core.Root`): one sample 30 s after boot, then
every 5 minutes (a one-shot timer chain; there is no change signal for memory),
posted at once to the page's own server (`POST /api/tab-memory/sample`,
`agentWrite: "telemetry"`). Top-level documents only (an embedded document's
memory is its host page's). A failed post is dropped (the next sample carries
the state; nothing is additive).

Sample: `sampledAt`, the page identity (`getTabId()` + `performance.timeOrigin`
→ one row per page load: a reload is a new heap), `host`, `route`
(`currentRoutePath()`), `visible`, `automated` (`navigator.webdriver`: the
agent browser and e2e runs, filtered out by default), `jsHeapUsedMb` /
`jsHeapTotalMb` (nullable), `domNodes`, `canvases` / `canvasMb`, `imagesMb`,
`iframes`, `media`, and `inAppTabs` — every open in-app tab of every mounted
tab set (page's and embeds'), `{ set, appId, path, focused }`.

`inAppTabs` needs one primitive: `TabSetHandle.openTabs()` and
`peekTabSets()` in `apps-core/tabs` (the registry already exists for
`peekFocusedTabSet`; it does not expose the tabs).

### 2. Stored as a log channel, per worktree

The server writes each sample to a durable log sink `tab-memory`
(`~/.equin/worktrees/<wt>/logs/tab-memory.jsonl`), beside `health-host` /
`health-owners`: readable with `cat` after the fact, bounded by the file
sink's rotation, nothing to migrate. A page on a worktree preview writes to
that worktree's log; the reader scans every worktree.

### 3. The renderer gets its pid — `sentinel/machine-usage`

`TopProcessSchema` gains optional `pid` (old lines still parse), filled by
`summarizeOwners`. A renderer is then a series, not a name.

### 4. Reading it — Debug → Tab memory

`tab-memory.series` live value (external, notified by a watch of the
worktrees root on `tab-memory.jsonl` / `health-owners.jsonl`, throttled
30 s, read window 12 h):

- **Renderers**: main's `health-owners` top processes named
  `Google Chrome Helper (Renderer)` with a pid, footprint per pid.
- **Pages**: every page that sampled in the window — its series and its
  latest sample.

Pane:

1. Chart *Chrome renderers* — footprint per pid (MB).
2. Chart *Pages* — each page's JS heap (MB), same time axis.
3. DataView of pages — host, route now, focused app, open in-app tabs, JS heap
   now and growth (MB/h over its life), DOM nodes now and at first sample,
   canvases/images MB, age, last sample; automated pages hidden by a filter.

**How to read a ramp**: find the climbing pid in chart 1, read its window;
the page whose JS heap or DOM count climbs in the same window in chart 2 is it.
If no page's JS figures climb (native growth), the pages alive and visible
through the window, with their in-app tabs and routes, are the candidates
— and the row's in-app tabs list says what that page held mounted.

## Not done here

- Cross-origin isolation (would give `measureUserAgentSpecificMemory`, exact
  per-frame bytes) — a wide change (every embed, every third-party script).
- An automatic renderer ↔ page join: Chrome exposes nothing linking them to a
  page without a debugging port.

## Verification

- Unit: the sample builder's pure parts, the series reducer (pages grouping,
  growth rate), `summarizeOwners` keeps pid.
- Build, open a page on this worktree, wait for samples, read
  `~/.equin/worktrees/<wt>/logs/tab-memory.jsonl`, open Debug → Tab memory.
