# Where a browser tab's memory goes, and what leaks

Task: att-1794371224. The user's tabs running the app sit around 1.2 GiB and
have reached 12 GiB. Nobody had broken that number down; every memory doc in
`research/` was backend-only. This splits the tab's memory, layer by layer,
and checks each layer for leaks.

Tooling: the sibling task's `e2e-harness/e2e/leak-test.ts` (landed in
parallel) owns the JS-heap side — three snapshots, survivors, retainer paths.
This work added what it cannot see, in
`plugins/debug/plugins/profiling/plugins/tab-memory`: `clean-soak.ts` (native
memory per allocator with nothing attached to the page) and
`listener-probe.ts` (who adds the listeners a tab accumulates). The snapshot
diffs below were made with ad-hoc scripts of the same method before
`leak-test.ts` landed.

## TL;DR

1. **The 12 GiB is real and it is time-driven, not navigation-driven.** Main's
   `health-owners` log (one sample every 30 s, the largest processes named)
   shows one Chrome renderer climbing **3.3 GB → 10.75 GB between 12:10 and
   17:30 UTC on 2026-11-10**, ~1.4 GB/h, after sitting flat at 3.3 GB from
   05:00 to 12:00. Nov 9 shows the same shape (1.7 → 4.3 GB over 01:00–07:00,
   flat, 5.4 GB at 13:00). The Nov 10 ramp ends at 17:30 with Chrome as a
   whole going from 25.5 GB (66 processes) to 6.2 GB (38) in five minutes —
   the user closed the tabs or restarted the browser — and the largest
   renderer since then has stayed at 1.5–2.4 GB.
2. **Navigation does not leak at GB scale.** A long session (every app, 3
   conversations opened/closed, list scrolls, the piano roll on 2 songs, the
   map, the browser app) repeated 4–8 times leaves the JS heap flat
   (~141 → 152 → 152 MB at the end of rounds 0/1/2, after forced GC). The
   three-snapshot diff finds ~8 MB per round, almost all JIT code and strings;
   with nothing attached the whole renderer grows ~1 MB per round. The
   sibling tool measured ~8 KB/iteration on its flow.
3. **An idle tab with nothing attached does not leak at GB scale either**, at
   today's live-update rate (see *Idle soak, clean*). So the hours-long ramp
   needs something the user did that these runs did not, and the candidates
   are the multipliers below.
4. **The biggest single cost is Sonata's piano: 505 MB of decoded samples**
   (`partition_alloc/array_buffer`) from the moment the piano roll opens until
   the tab leaves Sonata — per AudioContext, so per Sonata in-app tab.
5. **Every open in-app tab stays mounted** (keep-alive), with no cap or
   eviction, so each tab's whole app — Sonata's 505 MB included — is paid per
   tab, for the life of the browser tab.
6. **Measurement trap**: a Playwright-driven page inflates exactly the native
   memory this is about. Playwright enables the `Network` and `Runtime`
   domains on every page (the inspector then keeps response bodies and console
   arguments: after a few navigation rounds the `buffer` partition is 251 MB
   under Playwright vs ~15 MB without), and each heap snapshot leaves 150–200 MB of malloc high-water
   behind. Native numbers must come from a browser nothing is attached to
   (`clean-soak.ts`).

## Method

- **Counters after forced GC**: CDP
  `Performance.getMetrics` (JS heap, DOM nodes, documents, frames, JS event
  listeners, layout objects), canvas backing stores and decoded `<img>` pixels
  in the DOM, renderer and GPU process RSS.
- **Chrome's own accounting**: a `memory-infra` trace with
  one detailed dump, the same numbers the Task Manager's *memory footprint* is
  built from, split per process and per allocator (v8 / malloc /
  partition_alloc / blink_gc / web_cache / cc / gpu / …).
- **Three heap snapshots** A (after a warm-up round), B (after N rounds or
  half an idle soak) and C (one more round or the rest of the soak). Node ids
  are stable within a renderer session, so "allocated between A and B, alive at
  C" is the leak set. It is grouped by constructor and by nearest retainers,
  with full shortest retainer paths and dominator retained sizes.
- **Listener attribution** (`listener-probe.ts`): wraps
  `EventTarget.prototype.add/removeEventListener` before boot and keeps a live
  count per (target type, event type) with the adding stacks.
- **Clean measurement** (`clean-soak.ts`): spawns `chrome-headless-shell`
  itself and talks CDP only to the browser target (memory-infra dumps). In
  rounds mode it navigates through `Runtime.evaluate` on a flat page session
  with no domain enabled.
- **Real-world history**: main's `health-owners.jsonl` (renderer sizes over
  days) and the latency ledger (live updates delivered per hour).

All runs: headless Chromium 1400×900 at DPR 1, so tile/GPU memory is lower
than on the user's retina screen.

## The renderer at boot (`/agents`, clean)

Private footprint ~300 MB:

| allocator | MB | what |
|---|---|---|
| v8 | ~100 | JS heap ~80 MB old space; code ~6 MB |
| malloc | ~70–95 | unattributed native (ICU, style, fonts, IPC, …) |
| web_cache | ~45 | Blink's resource cache: the ~2,000 per-plugin JS modules, CSS, fonts |
| blink_gc | ~18 | Oilpan: DOM, listeners, CSSOM |
| blink_objects | ~28 | |
| partition_alloc | ~20 | strings, vectors |
| canvas / cc | ~10–20 | |

A conversation page adds ~110 MB (footprint ~410 MB): ~40 MB more JS heap
(the transcript, Shiki highlighting — whose Oniguruma WASM memory alone is
16.8 MB), ~15 MB of resource cache and DOM.

The JS heap has no dominant retainer: the largest dominators in a full-session
snapshot are Shiki's WASM memory (16.8 MB), script sources (5.6 MB) and
then a long tail under 3 MB (React fibers, live-state data, the toast history).
The heap is ~1,950 module scripts' worth of code (`(code)` 46 MB,
`JSModuleScript` ×1,951) plus live data.

## Growth per flow (session rounds)

Mean change of the JS heap / DOM nodes / JS listeners across one step, rounds
1+ (after forced GC; from `tm1`):

| flow | heap MB | nodes | listeners | note |
|---|---|---|---|---|
| open a conversation | +23.5 | +7,243 | +3,004 | |
| close it | −21.8 | −7,147 | −2,954 | released |
| scroll the sidebar task list | +2.4 | +2,633 | +262 | virtualized rows mount |
| Sonata library | +13.6 | +15,024 | −1,044 | 40 SVG covers = 40 SVG documents |
| piano roll | −9.7 JS, **+505 MB native** | −14,253 | −561 | decoded piano samples |
| map, browser app, settings, debug, studio, events, home | ±5 | ±2,000 | ±300 | released |

End of round on the same page: heap 141.7 → 152.2 → 152.5 MB, nodes 21.9k →
24.5k → 24.5k: one-time warm-up (caches, the 5-minute TanStack `gcTime`
window), then flat. The leak set over a round is ~8 MB, mostly JIT code.

**Sonata's 40 frames.** `Performance.getMetrics` reports +40 Documents and
+40 Frames on the library, though no `<iframe>` exists. They are the 40 song
covers: each is an `<img src="….svg">`, and Blink renders an SVG image in an
internal document of its own. 22 KB each, kept in the memory cache —
bounded, not a leak.

## Confirmed costs and leaks

### 1. Sonata's piano samples: 505 MB native, per AudioContext (bounded, large)

Opening the piano roll takes the renderer from ~385 MB to ~865 MB:
`partition_alloc/partitions/array_buffer` = **505 MB** (the JS heap does not
move: the data is `AudioBuffer` PCM). It is exactly flat across 6 song
switches (no accumulation), stays while the user is anywhere in Sonata
(library included) and is freed when the tab leaves the app.

Cause: `audio/piano` builds smplr's `SplendidGrandPiano`, whose full sample set
(every note × velocity layer) is decoded up front to float PCM. The shared
loader (`audio/sample-loader`) dedupes it *per AudioContext*, and the engine
builds one context per mount — so two Sonata in-app tabs (keep-alive, below)
hold two copies. Filed as a follow-up.

### 2. Keep-alive in-app tabs multiply every app's cost (unbounded count)

`apps-core/tab-surface` / `surface` mount **every open in-app tab at once**
(`display: none` for the unfocused ones) and persist the tab set in
sessionStorage. There is no cap and no eviction of long-unfocused tabs. A
conversation tab is ~110 MB over the base, a Sonata tab ~600 MB, and each one
also keeps its live subscriptions (and so its share of every live push) for
as long as it is open. A browser tab that has accumulated in-app tabs over a
day pays all of them. This is the most likely multiplier behind the 1.2 GiB
routine number. Filed as a follow-up.

**Fixed 2026-11-12** (`apps-core/tabs` `useResidentTabs`): only the tabs on
screen and the 2 most recently focused hidden ones stay mounted; the rest are
unloaded (route, title and scroll kept, app unmounted). `clean-soak.ts --tabs`,
`/agents` + 8 in-app tabs (Sonata, 3 conversations, Pages, Places, Events,
Studio), 6 focus rounds, main vs the fix side by side: footprint 941 → 726 MB,
V8 313 → 138 MB after round 5, flat across rounds. The desktop (windows mode)
still keeps every window mounted — `task-1794458652-w4qp7j`.

### 3. Toast history keeps each custom toast's portal container and ~140 React root listeners (bounded)

Idle `/agents` on main (Playwright, 30 min): JS event listeners 1,133 →
10,340 with DOM nodes flat. The listener probe names all of them:
`react-dom`'s `listenToAllSupportedEvents` on a fresh `<div>` — React attaches
its ~70 root listeners (capture + bubble, `dispatchEvent.bind(…)`) to every
**portal container** — 16 new containers in 6 minutes, one per custom toast.

`shell/toast`'s `showCustomToast` portals the content into a `document.createElement("div")`
and hands sonner a body whose JSX closes over it. Sonner keeps every toast in
`Observer.toasts` (`ToastState`) after it is dismissed. The retainer path
from the C snapshot: `ResourceError` (global handle) → … → `Observer` →
`Array` → toast data → … → the `<div>` (`_reactListening`) →
`EventTargetData` → `RegisteredEventListener` → `native_bind`. React never
removes a container's root listeners, so the detached div and its listeners
live as long as the history entry.

It is **bounded**: sonner 2.0.8 (the lockfile's version) trims dismissed
toasts once the history passes 100 (`MAX_HISTORY_SIZE`, `trimHistory`), so at
most ~100 containers / ~14k listeners / a few MB. The comment in
`show-toast.tsx` still says sonner "never prunes" (it was written against
2.0.7). Not GB-scale; left as a note, plus the stale comment.

### 4. Measurement artifacts that look like leaks

- Under Playwright the `buffer` partition grew 78 → 126 → 251 MB over three
  rounds while the JS heap stayed flat — the inspector's
  `NetworkResourcesData` (5,154 entries in the snapshot) keeping response
  bodies because Playwright enables `Network`. The clean run: `buffer`
  9 → 15 MB over 7 rounds. (At boot `buffer` is transient either way — 10 to
  77 MB in the first 20 s with nothing attached — so compare after rounds,
  not at boot.)
- Renderer RSS jumps by 2–3 GB while a heap snapshot is taken and malloc
  keeps 150–200 MB of it afterwards: in the Playwright idle soaks malloc went
  96 → 269 MB, every step right after a snapshot; the clean soak of the same
  page shows malloc flat at ~70 MB.
- "DevTools console" roots in the snapshots: `Runtime` enabled keeps every
  logged argument alive. A user with DevTools open on the app pays the same
  (both effects), which is worth knowing when reading the Task Manager.

## Idle soak, clean (what time alone costs)

`clean-soak.ts`, two tabs on main (`/agents` and a live conversation that
streamed this session's own transcript), nothing attached, a memory-infra dump
every 2 minutes:

| tab | footprint MB, 0 → 20 → 39 min | malloc | v8 | blink_gc | rate |
|---|---|---|---|---|---|
| `/agents` | 299 → 302 → 320 | 90 → 72 → 75 | 101 → 103 → 105 | 18 → 30 → 40 | ~30 MB/h |
| a live conversation | 409 → 454 → 472 | 106 → 93 → 86 | 143 → 138 → 139 | 31 → 77 → 96 | ~100 MB/h |

Malloc, V8 and partition_alloc are flat; the only climb is Oilpan
(`blink_gc`: DOM, listeners, style), and on the conversation part of it is
the transcript itself, which grew the whole time (this session's own turns),
plus the toast history (§3). Main delivered ~5–11k live updates per hour
during these runs, as much as during the Nov 10 ramp — so update volume alone
does not produce 1.4 GB/h in an `/agents` or conversation tab.

The same harness in rounds mode (`--paths`: every app, three conversations,
Sonata library and piano roll on two songs, the map, the browser app — 21
steps per round) on this build: boot 306 MB → 482 MB after the warm-up round
→ 506, 506, 502, 505, 505, 507, 513 MB after rounds 1–7. One-time warm-up,
then ~1 MB per round.

## What explains 12 GiB

The real ramps are ~1.4 GB/h for hours while the user is active, and flat when
they are not (05:00–12:00 on Nov 10, with ~185 live updates/h delivered;
3,400–9,000/h during the ramp). Nothing measured here grows at that rate on
its own. With what is confirmed:

- A tab's base cost is ~0.3 GB, ~0.4 GB on a conversation, plus ~0.5 GB the
  first time it opens Sonata's piano roll — the 1.2 GiB routine number is
  base + a conversation or two + Sonata, or a few kept-alive in-app tabs.
- To reach 10 GB without a per-event leak, the tab must hold many mounted
  apps: keep-alive in-app tabs are the only unbounded count found (each
  Sonata tab adds ~0.5 GB, and an AppEmbed/desktop window is a tab too).
- What was **not** reproduced and stays open: a per-push or per-render leak
  in a surface these runs did not keep open for hours (a long-running
  conversation with heavy tool output, the file explorer's
  `files.computer.stat` pushes — 534 pushes per window in that afternoon's
  op-rate reports — the pages tree's no-op pushes, a canvas app left
  running). The tab-level history has no app or route attached, so the
  10.7 GB process cannot be attributed after the fact.

The structural gap is that the app records **no tab-side memory at all**: the
machine watcher sees "a Chrome renderer", the app sees nothing. A tab that
reported its own `performance.memory` / footprint with its open in-app tabs and
focused route would have named the 10.7 GB tab on the spot. Filed as a
follow-up.

## Follow-ups filed

Sidequests, manual start:

- `task-1794377773-2l306r` — Sonata keeps 505 MB of decoded piano samples per
  AudioContext while open.
- `task-1794377776-b2972y` — every open in-app tab stays mounted forever: tab
  memory scales with tabs ever opened.
- `task-1794377779-w0zmm1` — no tab-side memory telemetry: a 10.7 GB renderer
  cannot be attributed to a tab, app or route. Done: every page now
  samples itself into a `tab-memory` log and Debug → Tab memory draws it
  beside each renderer's footprint by pid
  ([`2026-11-12-global-tab-memory-telemetry.md`](2026-11-12-global-tab-memory-telemetry.md)).

Not filed: the toast history (§3) is bounded by sonner at 100 toasts; its
stale comment in `show-toast.tsx` is corrected in this change.

No leak was fixed here: none of the confirmed retentions is unbounded, and the
one that is (the hours-long ramp) has no identified cause yet — the telemetry
follow-up is what would name it.
