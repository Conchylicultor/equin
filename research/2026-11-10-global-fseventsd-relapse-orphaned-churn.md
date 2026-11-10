# fseventsd's relapse: orphaned churn loops, not the 2^32 crossing

Task: task-1794317642 (follows research/2026-11-09-global-fseventsd-stuck-state.md,
task-1794188988-ixjuwm, task-1794190702-eld769).

On 2026-11-10 at 13:32Z, fseventsd (pid 38796, started 09:06Z) had a 49 GB
footprint at 100–190 % CPU, with a load average of 33. This was the third
fseventsd process to reach this state in two days.

## Verdict

**The cause was three `node -e` churn loops orphaned by a crash repro.** The
repro is the parcel-watcher use-after-free script in
research/2026-11-08-infra-main-segfaults-parcel-watcher.md. Its parent is
*meant* to die by SIGSEGV. Its churn child (`for (;;) { writeFileSync(f);
unlinkSync(f) }` over 50 names in `/tmp/pw-race-*`) was killed only on the
"survived" path, so every crashing run left one loop running under launchd
(ppid 1). From 2026-11-09 12:30Z three of these loops ran for 25 h. They made
**99.1 % of the machine's FSEvents** (30 s count: 353k of 356k events, against
2.5k for all of `~/.equin`).

**The 11-09 "one-off" verdict (case b) was wrong, and so was the 2^32
hypothesis.** Each onset follows a run of the repro by minutes:

| onset | repro run (agent transcript) | fseventsd |
|---|---|---|
| 11-08 15:21–15:24Z | conv-1794150814-5x7gcm ran it 3× at **15:22:43Z** (upstream build, 3/3 SIGSEGV) | 4.8 % CPU at 15:21:22 → 59.6 % at 15:23:23, then pinned for 13 h (the crossing of 2^32 that day was a coincidence) |
| 11-09 12:30Z | conv-1794227367-y3gvy9 (filing the upstream issue) ran it at **12:31:19Z**; the three orphans started at 12:30:30–32Z | the event-id rate went from ~100/s to 52–115k/s; RSS passed 30 MB at 13:30Z; pinned from ~15:57Z |

The 11-09 restart *looked* like a fix because the 11-08 orphans had stopped
by then. The cause is unrecorded: the loop swallows every error, so a deleted
directory leaves it spinning without producing events.

## 1. How pid 80166 ended: jetsam, after regrowing

The unified log shows that the kernel killed it; it did not crash. The
DiagnosticReports hold only `cpu_resource` and `disk writes` reports, and no
crash report:

```
2026-11-10 01:27:38Z kernel memorystatus: killing largest compressed process fseventsd [80166] 81900 MB
2026-11-10 01:27:41Z launchd: Successfully spawned fseventsd[38770] because inefficient
2026-11-10 09:06:28Z kernel memorystatus: killing largest compressed process fseventsd [38770] 96744 MB
2026-11-10 09:06:31Z launchd: Successfully spawned fseventsd[38796] because inefficient
```

So there were **two** jetsam kills: 80166 at 01:27Z with 82 GB compressed, and
38770 at 09:06Z with 97 GB. Each new process logs `event logs … out of sync
with volume. destroying old logs` and `getting new uuid`: the unclean exit
throws away the FSEvents history. **The event id restarts near 0** (690 at
01:27:54Z), and every client that resumes "since id N" loses its place.

All three processes followed the same path (fs-latency monitor, hourly):

| pid | healthy phase | flood phase (ids/s, CPU) | pinned phase (ids/s, CPU) | end |
|---|---|---|---|---|
| 80166 | 04:23–12:29Z: 0.1–3.8k ids/s, 0–4 %, RSS 11–15 MB | 12:30–15:57Z: 52–115k, 19–56 % | 1.6–4k, 170–195 % (spikes to 345k during bursts) | jetsam at 82 GB |
| 38770 | none: the churn was already running | 01:27–03:30Z: 70–147k, 46–52 % | 1.4–3k, 150–170 % | jetsam at 97 GB |
| 38796 | none | 09:06–10:38Z: 95k, 42–51 % | 2–3k, 163–177 % | still running (49 GB) |

`daemon_procs.fseventsd.rss_mb` hides the growth: it showed 0.03–13 GB
because nearly all of the footprint is compressed. `top -stats mem,cmprs`
shows it (`49G 49G`).

## 2. How fast it grows, and what it tracks

The footprint, from `cpu_resource` reports and `top` (no root, so no
`footprint` or `vmmap`):

- 38796: 207 → 407 MB over 90 s at 10:18Z (2.2 MB/s), 49 GB by 13:32Z
  (~15 GB/h).
- 38770: 353 → 568 MB over 141 s at 02:24Z (1.5 MB/s), 97 GB at 7.6 h of age.
- 80166: 82 GB 13 h after the churn began (~6 GB/h on average).

**The growth tracks the event volume from the churn**, not the stream count
and not a client:

- The growth starts within an hour of the churn in every process (80166
  passed 30 MB at 13:30Z, 1 h after the churn began; 38770 at 56 min; 38796 at
  71 min). 80166 stayed flat for 8 h before the churn, at normal stream
  registrations and up to 3.8k ids/s.
- The decisive experiment: at **13:58:36Z the three orphans were stopped**
  (`kill`), with nothing else changed (same streams, same clients).
  fseventsd went from 100–190 % CPU to **1.7–7 %** on the next tick, and the
  id rate fell from ~110k/s to ~1–2k/s. The footprint stayed at 49 GB: the
  memory is not given back.

### Where the CPU goes

A `cpu_resource` report has a stack. Disassembled (`otool -tV`, fseventsd
1413.100.6), the notify thread is in the **event table** (fseventsd+0x5800):

- CRC32 of the path picks a bucket.
- The table doubles up to a hard cap (`mask*2+2 < 0x80000`), and past it stops
  growing.
- The chain walk compares each node's device, and for every node calls
  +0x12a7c: lock a global mutex, then scan a 32-entry array. 13 of 18 samples
  are in that scan.
- Then it compares node+0x28 against an argument and runs `strncmp` on the
  path.
- A miss mallocs a 192-byte node.

The hash covers the path only, but the match key also includes node+0x28. If
that field differs per create (for example an inode or a generation), each
create/unlink of the same 50 names adds a node to the *same* bucket chain. The
memory then grows with the number of events, and each event walks a chain that
grows with it. This fits what we see: the CPU depends on events landing on the
churned paths (it fell to 2 % with 49 GB still resident), and the throughput
collapses to 1–3k/s as the chains grow. This reading needs symbols to confirm.
The 11-09 sample put the hot spot in the path-intern table (+0x41a4), the same
kind of structure.

## 3. The relapse pattern

1. A runaway writer creates and deletes files in a loop (here 100k+
   events/s, sustained for a day).
2. fseventsd keeps per-event state for those paths: tens of GB, never freed
   while it lives.
3. It pins at one or two cores once the chains are long (after 1–3 h). Every
   FSEvents watch on the machine is then late by seconds to minutes.
4. jetsam kills it at 80–100 GB. launchd respawns it, it **destroys the event
   history**, and the cycle restarts in the new process while the writer
   lives.

A restart alone does not fix anything while the writer runs. It also costs
every client its history.

## 4. What equin can change

- **The writer (done).** The three orphans were stopped. The repro in the
  parcel-watcher doc now bounds its churn child by its parent
  (`process.ppid` changes when the parent dies, which a SIGSEGV can't prevent)
  and by a deadline. Verified: the child exits within 1 s of a SIGSEGV to its
  parent. The same script was posted upstream (parcel-bundler/watcher#279) and
  should be corrected there too; that is outward-facing, so it is left to the
  user.
- **Detection (done): the `fsevents-flood` io-health rule.** Hour median
  ≥ 20k ids/s between ticks of the same fseventsd pid. Without a runaway
  writer, every tick since 11-09 stayed ≤ 39k/s (p50 0.7k, p99 19k,
  n = 1,214). Replayed on the recorded log, it raises at **11-09 13:00Z**,
  30 min after the orphans started: 3 h before the pin and 12.5 h before the
  first jetsam kill. It raises nothing outside the churn. The `daemon-cpu`
  what-to-do no longer points at 2^32.
- **equin's own volume and streams are not the lever here.** All of
  `~/.equin` was 0.7 % of events during the flood. After the kill, every equin
  stream was still open and fseventsd sat at 2 %.
- **The remaining FSEvents watchers** (main, `watch-delivery:fs-events`
  variants): `file-watcher.dirs` 715 samples, `corpus-index.stats.cost.usage`
  542, `transcript-watcher.transcripts` 526, `op-store.op-log` 308,
  `io-health.fs-latency-log` 187, `file-watcher.dir-entries` 152,
  `plugin-tree.plugins-dir` 108, `git-watcher.refs` 28,
  `prototypes-files.tree` 11, `config_v2.config-files` 1. Their
  multi-hour maxima (up to 2.7 h) fall in the flood windows. Some may also be
  the history resets after each jetsam kill. Not separated here.

## The Apple side

fseventsd has no bound on its per-path event state under create/delete churn
of a few names. Its lookup is O(chain) under a global mutex. Its recovery
(jetsam, then a relaunch) throws the FSEvents history away for every client.
equin cannot fix this. It is tracked on the Backlog page.

## Appendix: the FSEvents counter (no root)

`swiftc -O count.swift -o count && ./count <seconds> <path depth>`: one stream
on `/`, with file events, CF types and latency 0.2 s. It prints the events
delivered, the current-id rate and the top paths. These are fseventsd's
*output* events (after its coalescing), so they are a lower bound.

```swift
import Foundation
import CoreServices
let secs = Double(CommandLine.arguments[1])!, depth = Int(CommandLine.arguments[2])!
var counts: [String: Int] = [:]; var total = 0
let cb: FSEventStreamCallback = { _, _, n, paths, _, _ in
  let ps = Unmanaged<CFArray>.fromOpaque(paths).takeUnretainedValue() as! [String]
  for i in 0..<n {
    total += 1
    let c = ps[i].split(separator: "/", omittingEmptySubsequences: true)
    counts["/" + c.prefix(depth).joined(separator: "/"), default: 0] += 1
  }
}
let s = FSEventStreamCreate(nil, cb, nil, ["/"] as CFArray,
  FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.2,
  FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagUseCFTypes))!
FSEventStreamSetDispatchQueue(s, DispatchQueue.main); FSEventStreamStart(s)
let id0 = FSEventsGetCurrentEventId()
DispatchQueue.main.asyncAfter(deadline: .now() + secs) {
  print("delivered \(total) (\(Double(total)/secs)/s), \(Double(FSEventsGetCurrentEventId() - id0)/secs) ids/s")
  for (k, v) in counts.sorted(by: { $0.value > $1.value }).prefix(30) { print(v, k) }
  exit(0)
}
dispatchMain()
```
