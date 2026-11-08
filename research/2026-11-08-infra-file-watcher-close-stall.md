# Main's remaining short stalls: the watcher close, icons, themes

Task: task-1794159310 (re-filed from task-1794150853-29ikxp). Source: the 24 h
after-audit, `research/2026-11-08-global-app-health-24h-after.md` §3 and §6
item 17. Every number below was measured on this host (load average 25–32
during the runs, so medians and minimums are given, not single runs).

## Main's short-stall traces, 48 h to 17:40Z

From `traces` (trigger_kind `stall`, main's DB), grouped by culprit stack:

| culprit | traces | blocked | cause |
| --- | --- | --- | --- |
| `watch ← FSWatcher ← watch ← watchChildren` | 6 | 0.52–0.94 s each | Bun `fs.watch` OPEN (§1) |
| `close ← closeNativeWatcher ← … ← closeAll ← unsubscribe ← stop` | 1 | 1.17 s | Bun `fs.watch` CLOSE (§1) |
| `parse ← symbolBody ← appIconSvg ← catalogApp ← appCatalog` | 5 | 0.57–1.83 s | 19 MB JSON parsed per app (§2) |
| `RegExp ← readsVar ← subThemeBlockValues ← … ← renderThemeHead` | 2 | 0.59–1.31 s | RegExp per token × var (§3) |
| `drawRuntimeSymbol ← withSymbolSets` | 1 | 0.67 s | once per process (§4) |
| others (markdown parse, playwright load, a sync append, an fd probe) | 5 | — | not in this task |

The watcher stalls clustered right after main's builds (boot opens every
watch). Main has run 9b06a6dcc5 since 17:21Z: no `watchChildren` or
`closeNativeWatcher` stall since. That window is too short to prove anything
alone, so §1 measures the mechanism directly.

## 1. Why a watch close took 1.2 s

**It was Bun's `fs.watch`, not the kernel's close(2).** On macOS every
`fs.watch` of a directory in a process shares ONE FSEvents stream that Bun
re-creates whenever a watch opens or closes. The re-creation runs on Bun's
`CFThreadLoop` thread and holds Bun's FSEvents-loop lock. The JS thread's
`FSWatcher.close()` (and `fs.watch()`) waits on that lock.

`scripts/measure-watch-blocking.ts` (file-watcher) opens and closes 20 watches
of fresh dirs per round, timing each call on the JS thread. A `sample` of the
process during the `fs.watch` phase (Bun 1.4.4, 113 samples):

- **JS thread**: 93 of 113 in `_os_unfair_lock_lock_slow → __ulock_wait2`, that
  is, waiting for the lock.
- **`CFThreadLoop` thread**: 98 of 113 in
  `FSEventStreamStart → register_with_server → f2d_register_rpc → mach_msg`, a
  synchronous Mach RPC to `fseventsd`.

So every open and every close costs the JS thread one `fseventsd` round trip.
fseventsd sat at ~190% CPU on this host (measured in 9b06a6dcc5). With it that
loaded, one round trip takes over a second. That was main's 1.17 s close, and
the 0.5–0.9 s opens.

| backend (macOS, 3–4 rounds × 20 watches) | open, JS thread | close, JS thread | worst loop lag |
| --- | --- | --- | --- |
| Bun `fs.watch` | 28–76 ms median, max 445 ms | 32–50 ms median, max 616 ms | 128–613 ms |
| parcel FSEvents (`subscribeChildren`) | 0.05 ms median, max 1.7 ms | 0.03–0.04 ms median, max 0.6 ms | 1.6 ms |

(One parcel run showed a single 436 ms open and a 462 ms lag. It did not
recur in three later runs, so it is not attributed. The first subscribe of a
process starts parcel's FSEvents backend thread, which is a candidate.)

**parcel does the same fseventsd RPCs, off the event loop.**
`UnsubscribeRunner` / `SubscribeRunner` are napi async work. Their `execute()`
(`FSEventsBackend::unsubscribe → stopStream`, and `startStream`) runs on Bun's
worker pool. The parcel-phase sample shows `FSEventStreamStart` and
`FSEventStreamStop` only on `Bun Pool` threads, with the JS thread idle in
`kevent64` for 110 of 113 samples.

**The fix is 9b06a6dcc5 (already on main).** On darwin a `children` watch is
its own parcel subscription, and `fs.watch` is no longer used there. No
change to the engine is needed. Its own rules already keep `fs.watch` out of
darwin: the backend choice `watcherBackend`, and the `no-raw-fs-watch` lint
everywhere else. Off macOS `fs.watch` is inotify, with no shared stream. The
mechanism is written into `file-watcher/CLAUDE.md` beside the paragraph on
Bun's missed writes.

## 2. Icons: the Material Symbols sets parsed once per app per call

`GET /api/menu-bar/apps` (the native helper's catalog, read on every panel
load) hashed each app's icon SVG. `appIconSvg` called `symbolBody`, which
`readFileSync`ed and `JSON.parse`d BOTH sets (8.5 + 10.5 MB) per call. One
catalog was 19 apps × 2 parses. The PNG route did the same once per (app,
size) miss.

The glyph needed is a manifest symbol in the default style at rest: an app's
icon is a `symbol("…")` literal, which the build scans. The sprites' build
already resolves every manifest symbol in every style in one pass over the
parsed sets, once per process; the resident default sprites need it at boot.
That pass now also keeps each manifest symbol's default-style body
(`manifestSymbolBody`, sprites/machine). The app-icon renderer reads it from
there, so no request parses the sets. `symbolBody` remains only for the
one-shot release CLI.

Measured with a throwaway script, not committed: a `scripts/` folder may not import a `machine` barrel. It timed `symbolBody("home")` ×5, then `appCatalog()` once cold and ×5 warm, in one process:

| | before | after |
| --- | --- | --- |
| one glyph (`symbolBody`) | 202 ms median | — |
| one catalog | ≈ 3.8 s (19 × that), on every call | first call 430 ms (the one sprite build, shared with the resident sprites), then 1.1 ms median |

This is not an invalidate-all cache. The inputs (the manifest compiled into
the process, the installed sets) cannot change under a running process. The
bodies are a by-product of a build the process does anyway.

## 3. Themes: a RegExp per token × var per round, per entry

The server's first-frame head (`renderThemeHead`) paints one entry per app
path: the `""` entry plus every app with its own theme document or scheme.
Each entry re-painted every sub-theme and fixed-theme block, which are the
same in every entry. Each sub-theme fragment ran `subThemeBlockValues`, a
fixpoint that compiled `new RegExp(…)` for every (token, re-declared var) pair
in every round. It re-renders on any config-dir change.

Two changes, both byte-identical in output (the output hash is equal old vs
new with 0, 4 and 19 themed apps):

- `subThemeBlockValues` reads a per-group derivation index: var → the tokens
  whose default reads it, built once per token-group spec in a `WeakMap` (a
  spec is immutable data, so there is nothing to invalidate). The fixpoint
  walks only what the named tokens reach, round by round in schema order,
  exactly the old rounds.
- `themePainter(sources)` paints several selections over one set of sources.
  Each block is a function of the sources and its (theme, scope) alone, so it
  is rendered once per painter. `renderThemeHead` makes one painter per render
  and drops it after; nothing persists across renders. `paintThemeStyles` is
  one selection over a fresh painter, so the browser's painter is unchanged.

`plugins/ui/plugins/theme-engine/scripts/measure-theme-head.ts` (19 groups, 14
code themes, 13 sub-themes, 5 fixed themes, 19 tab apps, 4 themed: 5
entries), interleaved A/B on the same host, 40 runs each:

| | median | min |
| --- | --- | --- |
| before | 62–73 ms | 38–43 ms |
| after | 5–9 ms | 3.3–4.7 ms |

## 4. Not fixed here (filed)

- `drawRuntimeSymbol ← withSymbolSets` (0.67 s, once per process per style):
  the saved-icon drawer draws EVERY saved-able name (the whole Material set)
  for a style the first time any name in it is asked for. It is not per call.
- `icons.saved-sprites` slow-op reports (report-1793813697-qkfbu5,
  report-1794150715-36i5xm). The resident value recomputes whole on any write
  to any saved-icon source's table (`reads.tables`), so it is O(all saved
  names + every source query) per write.

Both are filed as sidequests; neither is a per-call glyph or theme
recomputation.
