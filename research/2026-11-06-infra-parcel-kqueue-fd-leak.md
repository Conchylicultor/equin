# @parcel/watcher 2.6.0 kqueue: a deleted or renamed watched file keeps its descriptor

Part of the responsiveness audit (task-1793965642-94fdhj).

## The leak

`writesWhileOpen` follows run parcel's kqueue backend on darwin
(`infra/file-watcher/shared/follow-files.ts`), which holds one descriptor
(`open(O_EVTONLY)`) per watched entry. In `src/kqueue/KqueueBackend.cc`
(2.6.0):

- `start()`, on `NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE` of a file's own
  descriptor: removes the path from the tree, erases the fd from
  `mFdToEntry` and the path from `mSubscriptions` — and never `close`s it.
  It also reads `entry->state` after `tree->remove(path)` has freed `entry`
  (use-after-free; works by luck), and with two subscriptions on the path
  iterates pointers into `mSubscriptions` entries it just erased.
- `compareDir()`, an entry gone from the directory listing: same erase, no
  `close`.
- `unsubscribe()` closes only descriptors still in `mSubscriptions`, so the
  dropped ones stay open for the life of the process (the backend is a
  process singleton).

What leaks in practice: one descriptor per followed file that goes — an SDK
agent's `events.jsonl` rotating (every 128 MB, per agent), a background
shell's output file deleted while on screen. Unbounded over a backend's life.

## The fix

`patches/@parcel%2Fwatcher@2.6.0.patch`:

- Both removal paths queue the descriptor in a per-batch `closing` set,
  closed after the whole batch is handled — never mid-batch, where a
  `watchDir` of a file created in the same batch could get the same number
  back while a later event of the batch still names the old file.
- The delete branch is tested before the directory diff (a directory whose
  last entry went and which was removed reports `NOTE_WRITE | NOTE_DELETE` in
  one event; diffing it left its own descriptor). It queues every
  subscription's own descriptor (watchers rooted at nested dirs keep separate
  trees, each with its own descriptor of the path), copies the path before
  removing it from the trees (no read of the freed entry), and erases the
  path's subscriptions once, after the loop.
- A removed directory's entries go with it (`forgetDescendants`, in the delete
  branch and in `compareDir`): each watcher that did not ignore one hears it
  removed, its descriptor is queued, and it leaves the tree — upstream left
  them open, mapped to freed entries (delete branch) or stale in the tree
  (`compareDir`).
- `unsubscribe` closes a descriptor unless another subscription holds that
  same descriptor (upstream counted the path's subscriptions, so with nested
  watches the first to leave kept its own open), and clears it off its
  `DirEntry`: the tree is cached by path and outlives the subscription when
  another shares it.
- `compareDir` closes its `dup` of the directory's descriptor on both early
  returns (`fdopendir` failing, a new entry failing to watch).
- `index.js` loads `build/Release/watcher.node` ahead of the prebuilt package.

Two independent reviews: the first found the nested-watch and directory
cases, the second the one-event write+delete, the dropped descendant events
of the first directory fix, and the `dup` leak — all upstream's, but one
introduced by v2, all fixed. Events are unchanged against upstream
(`repro3.js`: `rm -r` of a watched dir reports the dir and each entry deleted;
a dir recreated under the name reports its create, its new file's create and
a write to it).

Shipped as the `parcel-watcher-addon` `build` dependency
(`infra/file-watcher/plugins/parcel-addon`), copied into the checkout's package by
`./equin build`.

## Measured

`/tmp` repro: one kqueue subscription following 70 named files (the engine's
ignore shape), half deleted, half renamed, then recreated, then unsubscribed.
Descriptors over the process baseline (5):

| | subscribed | after the 70 go | recreated | after unsubscribe |
|---|---|---|---|---|
| upstream 2.6.0 | +74 | +74 | +144 | **+71** |
| patched | +74 | +4 | +74 | **+1** |

(+4 = the directory plus the backend's kqueue and pipe; the +1 left after
unsubscribe is the backend's, which upstream leaves too.) Writes to a followed
file and to a recreated one are still heard.

Regression test: `infra/file-watcher/plugins/parcel-addon/deps/internal/parcel-addon.test.ts`
(three descriptor cases plus the events of a removed and recreated directory; upstream fails the three descriptor cases — 41–64 held after the 40 followed files go, varying run to run — patched holds exactly 1, the directory's).

Cold build: ~21 s CPU serial; twelve parallel compiles in the dep take ~3.5 s
wall on an idle host.

More cases (`/tmp/pw-fix/repro2.js`; held over a baseline that includes a
warm subscription, so the backend's own are not counted):

| | upstream | patched |
|---|---|---|
| watched dir with two subdirs × 10 files; one renamed away, one `rm -r`: held after | 23 → 23 | 23 → **1** |
| … after unsubscribe | 12 | **0** |
| nested watches (`/b` and `/b/n`), `/b/n`'s 10 files deleted: held after | 23 → 23 | 23 → **3** |
| … after both unsubscribe | 21 | **0** |

## Not covered

- ~~Release bundles vendor the upstream prebuild~~ — since 2026-11-08 a darwin
  release seals `parcel-watcher-addon` (either arch) and vendors it; linux
  bundles keep the prebuild (inotify).
- `start()` reads and writes `mSubscriptions` / `mFdToEntry` without the
  backend's mutex while `subscribe` / `unsubscribe` hold it — upstream's race,
  unchanged.
- Upstream report: filed 2026-11-09 as https://github.com/parcel-bundler/watcher/issues/278 (minimal repro: 200 files created and deleted under one kqueue subscription, 16 → 216 → 216 descriptors on upstream 2.6.0).
