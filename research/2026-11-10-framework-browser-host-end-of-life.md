# A browser host's end of life: flush, then close, never under a connecting page

Task: task-1794343982 (track page block-d04c6c0d-56fd-49f2-88f4-914e059cc83b).
Root cause of tips-in-demo's "after a reload, no tip shows again" (task-1794337160-x8n8ak).

## Context

The demo's browser host is a SharedWorker running PGlite on IndexedDB with
`relaxedDurability`: a write reaches IndexedDB only after its query answered
(the sync runs behind the query lock, unawaited). The four host stores
(config, transcripts, attachment bytes, data files) write through to IndexedDB
fire-and-forget too. When the demo's last tab closes or reloads, Chromium
terminates the SharedWorker at once, so whatever is still being flushed is
lost. Observed: Got it on a tip, the worker answers, reload → the tip shows
again; waiting ~3 s first keeps it.

`extendedLifetime: true` on `new SharedWorker` keeps the worker alive past its
last tab, which fixes the loss, but then nothing ends it: profile-reload and
snapshot (`waitForStorageReleased`, the `equin-host:<name>` lock) and
sonata-in-demo ("the demo's workers end once no page holds them") fail.

## Measurements (2026-11-10, headless Chromium of the agent browser)

1. **Dropping `relaxedDurability`** — PGlite `idb://` cluster in a page, 61
   tables, medians over 20 queries:

   | | relaxed | durable |
   |---|---|---|
   | write (upsert) | 0.2 ms | 25.4 ms |
   | read (point select) | 0.1 ms | 7.9 ms |

   Durable mode awaits Emscripten's IDBFS `syncfs` after EVERY query, reads
   included, and `syncfs` walks the whole data dir. The demo's database is
   larger (its whole schema), so this is a floor: a demo boot issues hundreds of
   queries (seconds added), and every keystroke-driven write pays 25 ms+. It
   also does not cover the host stores' writes, nor a request the worker
   received but had not answered when the tab went away. **Rejected.**

2. **`extendedLifetime: true`** — the worker outlives its last client: it saw
   its last page's hello lock released, waited 1.5 s, wrote IndexedDB, then
   closed itself. Left alone it was still running 160 s later: the worker must
   end itself.

3. **The closing race** — a `new SharedWorker(url, name)` made ~0 ms after the
   worker of that name called `self.close()` (connect issued as soon as the
   worker's last message arrived) was matched to the dying worker: no message,
   no `error`, no MessagePort `close` event — it hangs for good. 1 ms later and
   after, it got a fresh worker. The window is tiny but real and undetectable
   from the page, so a correct design must make it unreachable rather than
   detect it.

## Design

**Keep `relaxedDurability`; the worker outlives its last tab
(`extendedLifetime`) and retires itself: once no page holds it, it closes its
storage (flushing everything) and the worker — under a Web Lock that no
connecting page can hold at the same time.**

### The retire lock: `equin-host-retire:<worker name>`

- **Page** (`connectSharedHost`, browser-server core, new):
  1. Ask for the retire lock of the name it would connect to, SHARED, with
     `ifAvailable`.
  2. Not available → a worker of that name is retiring (it holds the lock
     exclusively, or has asked for it): skip the name — the caller's
     `passed(name)` moves to the next one (the demo: the next host
     generation, the mechanism Reset already uses) — and try again.
  3. Granted → hold it, take its presence lock (the `hello` lock, moved here
     from `portBrowserServer`), `new SharedWorker(name)`, post `hello` at
     once (an unstarted port can post) — then release the retire lock when
     the worker's `accepted` arrives (the first thing it posts on a connection).
- **Worker** (`serveHost`'s new `retire` option): when its last end leaves
  (the hello lock released) after the boot settled, ask for the retire lock
  EXCLUSIVELY (abortable). A new connection aborts the ask, then posts
  `accepted`. Granted with no end → `retiring`: close the storage
  (`storage.close()`: PGlite flushed and closed, every store write settled,
  the `equin-host:<name>` lock released), then `self.close()` — holding the
  retire lock until the worker is gone.

A host that ENDED other than by Reset (`superseded`: another worker took its
storage over) retires the same way once told its pages — under the lock,
since its name was not moved past (Reset closes at once: every tab already
moved to the next generation). The lock stays held even when closing fails
(the failure is reported as the worker's uncaught error).

Why no page can reach a closing worker: a page connects only while it holds
the retire lock shared, and keeps it until the worker has taken its
connection in (`accepted`, posted after the worker aborted any retirement).
The worker retires only while holding the lock exclusively. So a connection is
either in the worker's ends before it decides, or made by a page that saw the
lock unavailable and went to the next name.

Reload: the old page goes → the worker retires (flush + close, a few hundred
ms) → the new page finds the lock taken → connects to the next generation's
name → its fresh worker waits on `equin-host:<name>` (no claim answered while
retiring) and opens the stored data. Same cold boot as today, with the data.

Known edge (no hang): a worker whose last end just left has asked for the lock
while a page A is mid-connect (holding it shared); a second page B connecting
in those milliseconds sees it unavailable and moves on to the next name, whose
worker claims the storage — A's host yields and A shows "opened in another
tab — Reload". Needs two tabs connecting within ms of the last one leaving.

### Ownership while retiring

`openHostStorage`'s close gets the same treatment `wipe` has: from the start
of a close, the holder answers no claim (`ownership.closing()` — the existing
`wiping()` generalized), so the next generation's worker waits on the lock
instead of ending a host that is already going.

### What changes where

- `framework/browser-server/core`
  - `port.ts`: `FromHost` `accepted` (posted on every announced end, first);
    `serveHost({ retire?: { lock, run } })`: the retirement above;
    `HostEndReason` `"retired"` (told to an attached frames port, and to any
    end that slipped in — none can with the protocol); `portBrowserServer`
    no longer sends `hello` (presence is a shared host's concern; a dedicated
    worker dies with its page) and ignores `accepted`.
  - `shared-host.ts` (new): `connectSharedHost({ open, name, passed })` →
    `{ name, port, leave() }`, and `retireLockName(workerName)`.
  - `browser-host.d.ts`: drop `prestartShared`; `startShared(name)` is the
    bare constructor.
- `framework/tooling/web-artifacts` `browser-hosts.ts`: the host module's
  `startShared` passes `extendedLifetime: true`; the prestart map leaves the
  generated module (it moves to `demo/prestart`, which owns the handshake).
- `framework/browser-server/host-storage` `serve.ts`: a SharedWorker host
  passes `retire: { lock: retireLockName(scope.name), run: close storage,
  then scope.close() }`; `WorkerScope` gains `name`. `open.ts`/`ownership.ts`:
  no claim answered once closing.
- `framework/browser-server/demo/prestart`: `prestartDemoHost` connects through
  `connectSharedHost` (generation skipped on a retiring name) and keeps the
  connection for the scope (`takePrestartedHost`).
- `framework/browser-server/demo/scope`: `connectHost` uses the prestarted
  connection or `connectSharedHost`; the generation it connected to is the one
  a Reset advances from; teardown calls `leave()`; `ended: "retired"` →
  reconnect like a reset (no data wipe, no scope storage clear).
- Docs: browser-server, host-storage, demo/scope, demo/prestart CLAUDE.md.

Out of scope (limits, written down): a browser without `extendedLifetime`
(Firefox, Safari) still ends the worker with its last tab — no worse than
today; the dedicated-worker fallback (no SharedWorker) likewise.

## Verification

- `./equin test` for browser-server, host-storage, demo/scope, demo/prestart,
  web-artifacts.
- `./equin build`, then every demo e2e script (`plugins/apps/plugins/demo/e2e/*.ts`,
  tips-in-demo unchanged — it must pass as written), `live-demo.ts`,
  `site-parity.ts`.
- A reload-in-the-same-instant check: tips-in-demo's Got it → immediate
  reload → the tip does not show again (the original repro).

## Outcome (2026-11-10)

- Every demo e2e script, `live-demo.ts` and `site-parity.ts` pass on the
  final build; tips-in-demo 3/3; desktop-in-demo failed once on a wallpaper
  context menu click (unrelated, passed on rerun). Unit tests
  (`core/internal/shared-host.test.ts`): retire after the last page, a page
  connecting while it retires goes to the next name, a page that connected
  first keeps it, an in-flight request finishes first, a superseded host
  retires too.
- `persistence.ts` step 5: rename a page, close every tab the instant the
  worker answers it (`armHostAnswers`, resolved inside the page), open a new
  tab → the new name is there. Passes here.
- **The loss of an ANSWERED write could not be reproduced against the old code
  (main 66a56c1ccd)**: step 5 passes there too — with a ~200 KB title, and
  with the reload issued inside the page in the same task that received the
  answer (a reload on main reconnects before Chromium drops the worker).
  tips-in-demo passes on main as well (2/2). The answer → flushed window is
  tens of ms; closing a tab over CDP takes longer. The brief's repro ("Got
  it, then a reload in the same instant") was the unsent seen-mark that
  66a56c1ccd made the test wait for. What the change provably adds: the
  worker finishes a request it received when its tab went (it used to be
  killed mid-request), flushes before dying, and ends itself with its lock
  released — held by the unit tests, not by a main-failing e2e.
