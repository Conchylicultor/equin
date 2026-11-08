# Main's "Bun" segfaults are @parcel/watcher's kqueue thread, and nobody reported them

Task task-1794150814-p1py4j (from the 24 h after-audit,
research/2026-11-08-global-app-health-24h-after.md §2.1, §6 items 1–2).

## 1. What happened

Main's backend died by SIGSEGV three times:

| when (UTC) | uptime | Bun's panic line | watcher.node |
| --- | --- | --- | --- |
| 2026-11-06 17:20:03 | 190 s | `Segmentation fault at address 0x2483B634B1688037` | upstream 2.6.0 prebuild |
| 2026-11-07 22:46:03 | 4.2 s (a hot restart's new process) | `Segmentation fault at address 0x28` | our patched build (aec983b780) |
| 2026-11-08 14:20:56 | 65 min | `Segmentation fault at address 0x7BC138` | our patched build |

Each time Bun printed `oh no: Bun has crashed. This indicates a bug in Bun,
not your code.` and a `bun.report` link. The gateway logged
`backend exited unexpectedly … err="signal: segmentation fault"` and
restarted it. No row reached `reports`.

## 2. bun.report decodes to nothing — and why

All three links decode to "unknown / js code" frames only (9, 6 and 10 frames).
Bun's crash handler (`src/crash_handler/lib.rs`, `StackLine::from_address`, at
38afee6c8) encodes a frame only when its address is in **image 0, Bun's own
binary**; for any other dyld image it returns `None` ("these libraries are not
interesting, mark as unknown") and writes `_`. So a stack made only of `_` means
**no frame was in Bun**: the crash was in a native addon, a system library or
JIT code. Bun's message is generic: it prints "a bug in Bun" for any fault.

## 3. The macOS crash reports name it

macOS's ReportCrash wrote a symbolized `.ips` for each crash
(`~/Library/Logs/DiagnosticReports[/Retired]/equin · server · singularity-<date>.ips`).
The faulting thread, every time, is the kqueue thread of `@parcel/watcher`'s
`watcher.node` (below `_sigtramp`; Bun's own frames above it are its crash
handler re-raising):

```
11-08  watcher.node  std::regex … __match_at_start_ecma
       watcher.node  std::regex … __search
       watcher.node  std::regex_match
       watcher.node  Glob::isIgnored
       watcher.node  Watcher::isIgnored
       watcher.node  KqueueBackend::compareDir
       watcher.node  KqueueBackend::start
       watcher.node  std::__thread_proxy<… Backend::run()::$_0>
11-06  (same chain, upstream prebuild: regex → Watcher::isIgnored → compareDir → start)
11-07  watcher.node  KqueueBackend::compareDir (×2) → start → thread_proxy
```

The frame counts match the bun.report stacks exactly (9, 6, 10).

## 4. The bug: an unlocked read of the subscription tables

`Backend::watch` / `unwatch` (JS thread) hold `Backend::mMutex` while
`KqueueBackend::subscribe` / `unsubscribe` change `mSubscriptions`,
`mFdToEntry` and the shared `DirTree`s. `KqueueBackend::start()` — the backend's
own thread — handles each kevent batch **without that lock**: `compareDir`
collects raw `KqueueSubscription *` pointers into `mSubscriptions`
(`findSubscriptions`) and calls `sub->watcher->isIgnored(…)` on each. An
`unsubscribe` running meanwhile erases those subscriptions, dropping their
`WatcherRef`, so the Watcher (and its `std::regex` ignore globs) is freed under
the pointer: a use-after-free that faults in the regex (11-06, 11-08) or in
`compareDir`'s own read of the freed subscription (11-07, address 0x28 — a field
of a freed struct). The 2026-11-06 descriptor-leak patch left this as is
("`start()` touches the subscription maps without the backend's mutex",
`parcel-addon/CLAUDE.md`).

**Our trigger:** `compareDir` runs on a NOTE_WRITE to a watched directory, and
the subscribe/unsubscribe churn is on the same directory — `runs/`, whose
supervisor follow closes and re-opens its subscription on every change of the
live-run set since 167d94c556 (11-06 16:31Z), while run starts create and prune
its entries (audit §2.2). The first crash came 49 min after that commit; the
11-07 one 2 s after a burst of supervised-run watch failures on `runs/`.

### Minimal repro (plain Node, no Bun, no equin)

`repro.js` (kept below) holds one kqueue subscription of a directory open, has
a child process create and delete files in it as fast as it can, and
subscribes / unsubscribes a second watcher (a distinct ignore glob each round,
so each is a fresh `Watcher`) in a loop:

| build | result (20 s, 3 runs) |
| --- | --- |
| upstream 2.6.0 | **SIGSEGV (exit 139) in 3 / 3** |
| `start()` holding `mMutex` per batch | survives, ~1,000–1,500 rounds each |
| task-1794150818's patch (lock + per-subscription trees) | survives 40 s, 1,059 rounds, 0 errors (run by that agent) |

```js
// usage: node repro.js <@parcel/watcher package dir> <watcher.node> [seconds]
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const [pkg, addon, secs = 30] = process.argv.slice(2);
const w = require(path.join(pkg, 'wrapper.js')).createWrapper(require(addon));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-race-'));
for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, `seed-${i}`), '');
const churn = spawn(process.execPath, ['-e', `
  const fs = require('fs'), p = require('path'); const d = ${JSON.stringify(dir)};
  let i = 0; for (;;) { const f = p.join(d, 'f' + (i++ % 50));
    try { fs.writeFileSync(f, ''); fs.unlinkSync(f); } catch {} }`], { stdio: 'ignore' });
const cb = () => {};
(async () => {
  await w.subscribe(dir, cb, { backend: 'kqueue' });
  const end = Date.now() + secs * 1000;
  for (let n = 0; Date.now() < end; n++) {
    let sub;
    try { sub = await w.subscribe(dir, cb, { backend: 'kqueue', ignore: [`**/*.ignored-${n % 7}`] }); }
    catch { continue; } // subscribe's own failures (§5) — not this bug
    await sub.unsubscribe();
  }
  console.log('survived'); churn.kill(); process.exit(0);
})();
```

## 5. Two more upstream bugs the repro surfaced (the §2.2 supervised-run failures)

- **`error watching <dir>: Undefined error: 0`** is deterministic: the
  `DirTree` is cached per directory and shared by every watcher of it, and
  `subscribe` calls `watchDir` on every entry of that shared tree — which
  returns false, with errno 0, for an entry THIS watcher ignores. A second
  subscription of a directory with a different ignore set fails whenever an
  entry it ignores exists. `runs/` has three such subscriptions.
- **`… No such file or directory`**: an entry crawled into the tree and deleted
  before `watchDir` opens it fails the whole subscribe.

Both are fixed in the addon by task-1794150818 (a private tree per kqueue
subscription read through its own ignore, ENOENT entries dropped, a failed
subscribe rolled back), which also lands the `start()` lock. One patch, one
owner: this task did not edit the patch.

## 6. Why nothing reported it, and the fix

A process killed by a signal runs none of its own code on the way out. The
in-process crash paths (boot-events' boot crash, the reports engine's
`processCrashSink`) never run; Bun only prints. The one witness is the
**gateway**: it has the wait status and the process's stderr. Now
(`gateway/crash_report.go`, plugin `debug/backend-crash`):

- `onBackendExit` sees a signal death the gateway did not send
  (`backend.signalled`, set by `signalBackend` before every kill it makes) and
  writes a `backend-crash` entry into the report outbox; main drains it (its
  own crash on its successor's boot). Every backend: worktrees, main, central.
- The entry carries the signal, pid, uptime, the binary's name (for the
  `.ips`), and the dead process's own last 60 stderr lines. The report reads
  Bun's panic line and bun.report link from them and points at the macOS crash
  report, which — unlike bun.report — symbolizes addon frames.
- **stderr is now a pipe the gateway owns.** With `cmd.StderrPipe`, `cmd.Wait`
  closed the read end as soon as the process exited, so the panic block — the
  last thing written — could be dropped from the pipe buffer. It is read to EOF
  now (bounded at 2 s, for a grandchild that inherited it).
- Exit-code exits are not filed: those processes ran their handlers and filed
  themselves.

**Activation:** the gateway is not rebuilt or restarted by `./equin build` or
`push`. It files nothing until `./equin start --force`.

## 7. Upstream

parcel-bundler/watcher: no existing issue (searched "kqueue segfault",
"unsubscribe crash", "Undefined error: 0"). The issue (§4 race, §5 two
subscribe failures, the repro above) is drafted here and tracked on the Backlog
page; filing it is outward-facing, so it waits for the user's go, as the
2026-11-06 descriptor-leak report does. Not a Bun bug: nothing goes to
oven-sh/bun.

## Mental model

- A backend is a Bun process the gateway starts. Bun can load native code
  (`.node` addons); @parcel/watcher is one — it runs its own C++ thread that
  watches folders with the kernel's kqueue.
- That thread and our JavaScript share a table of "who is watching what". The
  JavaScript side locked the table while changing it; the watcher thread read
  it without the lock. When we stopped watching a folder at the same moment the
  thread was processing a change in it, the thread read memory that had just
  been freed, and the whole process crashed.
- Bun's crash screen says "a bug in Bun" for any crash and only decodes Bun's
  own code, so its link showed nothing. macOS's own crash report showed every
  frame, and every crash was in watcher.node.
- A process that crashes cannot report its own crash. The gateway, which
  started it, sees it die and keeps what it printed, so the gateway now drops a
  report into the outbox and main files it, even when main itself was the one
  that crashed.
