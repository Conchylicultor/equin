# Debug → Logs V2

## Context

`/debug/logs` (`plugins/debug/plugins/logs`, one 184-line `log-viewer.tsx`) predates the current primitives:

- **Channel list = in-memory registry, not disk.** `GET /api/logs/channels` returns `getChannelIds()` — only channels published *in this backend process*. A sink that has not written since boot (or a `clientLog` channel before its first emit) does not exist in the UI. One-shot `fetchEndpoint` in an effect (exempted as debt `task-1791560308-woqgfi`, `live/no-endpoint-read`).
- **Entries = WS ring buffer (10k/channel), not the file.** History before the last restart, and everything in rotated generations (`foo.jsonl.1..3`), is invisible. `readChannelEntries` (8 MiB tail of the live file only) is used by other plugins, never by the page.
- **Rendering**: hand-rolled `entries.map` in `LogEntryList` (no DataView, no virtualization, unbounded client array), hand-built tab strip (one tab per channel, overflows), no search/filter/time, no loading or error state — an empty box means loading, empty and failed alike.
- **The sink set has no reader.** ~30 `defineLogSink` channels + 4 host-global `defineFileSink`s (op-log, build-progress, check-progress, signal-origin) + the `client-log` dynamic family. Each has a `description` and a `{maxBytes, keep}` rotate bound (`getFileSinks()`, merged into `retention.getGrowthBounds()`), which no screen shows.
- **Nothing links to a log.** Reports' investigation tasks name channels in prose ("the `live-state` log channel … grep `drop reason=`"); `logChannelPane` (`ch/:channel`) has zero callers.

Principle (from `2026-10-15-global-remove-sink-consumer-classification.md`): a log is evidence, not a signal. Alerts point at logs; logs never declare their readers. V2 makes *following that pointer* the primary path.

## Position: what is a log, what is a table

| Kind | Belongs in | Today's examples | V2 action |
|---|---|---|---|
| Prose / ops transcript read by humans & agents | **Log sink** (viewer) | migrations, db, change-feed, database-fork, mail-sync, release, deploy, sentinel, worktree-cleanup, clientLog channels | Viewer's core job |
| Structured records a screen queries/aggregates | **DB table + `defineRetention`** (or `liveCollection`) | health / health-host samples (Health charts, timeline, sentinel), slow-op-markers, boot, duress-episodes | Shown in the viewer (they are still files) but filed as follow-up tasks to move to tables. Not in this task's scope. |
| Cross-process writes from processes without a DB (CLI) | **Log sink as ingest journal → DB read model** | op-log → `op-store` (`op_log_ops`, 30-day sweep) | Already right; keep. The file is the journal, the table is what screens read. |
| Timed spans/events for causality | **Trace events** | — | No change. |

Rule of thumb for the CLAUDE.md: *if a screen parses a sink's lines into a chart or a list, that sink is a table waiting to happen.*

## The experience (to be prototyped)

Two panes, Miller-style:

1. **Logs catalog** (`/debug/logs`) — a DataView (table + list) of *every sink on disk*, not just published ones:
   - Name, owning plugin, `description`, scope (this worktree / host-global / browser `clientLog` family, grouped).
   - **Size vs bound**: live-file bytes / `maxBytes` as a meter, rotated generations `n / keep`, total on disk, "rotates in ~X at current rate" (from the last-write rate), last write (relative time, live).
   - Search / group-by scope / sort by size or last write come free from DataView.
   - Worktree picker (defaults to the page's own worktree; `logsDirFor(worktree)` already reads any).
   - Undeclared files in `logs/` (no sink, no family) shown flagged — evidence of an ad-hoc writer.
2. **Log reader** (`/debug/logs/ch/:channel?wt=&at=&q=`) — one sink:
   - Header: description, bound meter, generation strip (`live · .1 · .2 · .3` with each one's time span), Copy path, Open in Finder-ish "copy `tail -f` command".
   - Body: virtualized DataView list, newest at bottom, **sticky tail when at the bottom**, stderr tinted, JSON lines pretty-expandable.
   - **Rotation is visible, not a cliff**: scrolling up crosses generations seamlessly, with a divider "rotated · 14:02 — older lines from `deploy.jsonl.1`". Past the last kept generation: "Nothing older — this sink keeps 3 × 128 MB" (an explicit end, not silence).
   - Filters: text/regex search (server-side, bounded), stream (stdout/stderr), time jump (`at=`) — the deep-link target.
3. **Report → log link**: a plain `logHref({ channel, worktree?, at?, q? })` in `debug/logs/core`. Reports/investigation tasks render it as a link instead of prose; the reader opens scrolled to `at` with `q` highlighted.

## Data design (after prototype review)

- **Catalog**: `liveValue("logs.catalog", params: { worktree })`, `serveValue` with `source: "external"`, `changes: "notified"`, `whileSubscribed` → `acquireDirWatch(logsDirFor(wt))` (+ host-global dirs), `throttleMs: 1000`. Loader = `stat` the dir's `*.jsonl` + `.N` files, joined with `getFileSinks()` descriptions/bounds and the dynamic-family declaration. Bounded by the files in one directory. Pattern: `plugins/release/server/internal/run-logs-resource.ts`.
  - Gap: a `defineLogSink` enters `getFileSinks()` only on first publish (lazy). Fix at the root: register the sink spec at define time (the file still opens lazily) so the catalog knows every declared sink's description even before it writes.
- **Reader**: a key-range-paged value (live CLAUDE.md "Paged reads") over the concatenated generations; a position is `(generation inode, byte offset)` so a rotation doesn't invalidate cursors. Newest window pushed via the same dir watch; older pages on demand. Search runs server-side over a bounded byte window and reports "searched back to <time>" rather than pretending to be exhaustive.
  - Moves the read logic into `infra/file-sink` (`readJsonlTail` already has `includeRotated`) — one reader for all generations, which `readChannelEntries` callers can then adopt.
- **Rendering**: `DataView` with `defineDataView("debug.logs.catalog")` / `("debug.logs.entries")`, `readiness={result}` (loading/error are real states). Pattern: `plugins/debug/plugins/trace/plugins/pane/web/components/events-view.tsx`.
- **Retire**: the endpoint-in-effect (closes the `live/no-endpoint-read` debt), the hand-built tabs, `LogEntryList` use on this page. `LiveLogChannel` + WS ring buffer stay for the release/deploy/build live panes (out of scope).
- **Gateway backend stdout** (`/gateway/worktrees/<wt>/logs` SSE) — today a synthetic first tab. Open question for review: keep as a catalog row backed by the gateway, or move it to the worktree page.

Critical files: `plugins/debug/plugins/logs/**` (rewrite, gains `core/` + `server/`), `plugins/infra/plugins/file-sink/core/internal/file-sink.ts` (multi-generation paged read), `plugins/primitives/plugins/log-channels/server/internal/{log,persist,handle-channels}.ts` (eager sink registration; channels endpoint retired), report task texts in `plugins/reports/plugins/{live-state-stale-drop,resource-errors,check-thread-stall}` (prose → `logHref`).

## Steps

1. **Prototype** — `./singularity prototype new "Logs V2"` (blank `_template/`, `<meta name="mocks" content="route:/debug/logs">`), realistic fake sinks from the table above. Options: `reader: inline | split` (reader below the catalog vs Miller column), `catalog: table | cards`. Screens: catalog, reader mid-scroll crossing a rotation divider, reader opened from a report deep link (`at` + `q`), loading state, "nothing older" end.
2. **User review** of the prototype. ← stop here.
3. Revise this plan (v2 doc if the direction changes), then implement: file-sink paged reader + eager registration → catalog value → reader value → web panes → `logHref` + report links → follow-up tasks (`add_task`) for health/slow-op-markers/boot/duress-episodes → tables.
4. `./singularity build`, verify.

## Verification

- `./singularity test plugins/infra/plugins/file-sink` — paged read across a forced rotation (small `maxBytes`), cursor stable after rotation, explicit end past `keep`.
- `./singularity build`, then `screenshot.ts --path /debug/logs` and `--path "/debug/logs/ch/migrations?at=…"`: every declared sink listed (including never-written ones), meters sane, scroll-up crosses `.1`.
- Write to a sink while the reader is open → line appears without reload (push, no polling).
- `compare-diff.ts --name <proto-id>` against the built route.
- `./singularity check` (exempt debt removed, `no-adhoc-row-list`, `config:overrides-authored`).

## After review — as built

The user approved the prototype on its defaults (catalog as a table, reader beside it as a column, the backend's output as a catalog row). Where the build differs from the sketch above:

- **The backend's output is a file.** The gateway already captures each backend to `~/.singularity/logs/gateway/<worktree>.log` with `.N` rotations, so the "Backend process" row reads it like any other log. No SSE path or special case is needed. Its bound is the gateway's own, so the row says "rotated by the gateway" and shows no meter.
- **Sinks are declared at import** (`FileSinkSpec.path` may be a function, resolved on first use). `defineLogSink` and the `client-log` family now register in `getFileSinks()` before their first write. This also fixes `retention.getGrowthBounds()`, which used to miss never-written sinks.
- **Positions:** a line's position is `(file birth µs, byte offset)` as fixed-width text, which stays stable across a rotation. It lives in `file-sink`'s `readHistory` / `statHistory` / `historyCutAt`.
- **Reader order is newest first.** DataView has no bottom-anchored mode, so new lines land at the top while the log is being written. Older history pages in as you scroll down, by viewport, at any depth. This needed a twin of the existing paging hook for paged values: data-view's `useLivePagedValuePaging`.
- **Search and the stream / file filters run in memory over the loaded rows.** A paged value has no filterable seam. When a search hides the tail, paging stops and the list shows what it has loaded. This is the honest form of "searched back to …".
- **`clientLog` channels have no description.** They are the open-ended family, so the catalog shows them, together with any other file nothing declares, as "Undeclared · clientLog".
- **Deep link:** `/debug/logs;wt=<worktree>/ch/<log>;at=<ms>` (pane keyed params).
- **Retired:** `GET /api/logs/channels` and its in-memory registry listing, the endpoint-in-effect debt exemption (`task-1791560308-woqgfi`), the hand-rolled tab strip and list, and `LogEntryList` from the log-channels web barrel.

Follow-ups (filed as tasks):

- Move the health / health-host samples, slow-op markers, boot events and duress episodes into tables with `defineRetention`.
- Give report kinds a structured log reference that renders as a link into the reader.
- Declare `clientLog` channels with a description.
- List host sinks that only CLI processes declare (build-progress, check-progress, signal-origin).
