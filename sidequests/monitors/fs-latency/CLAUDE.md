# fs-latency — on-demand diagnostics (the monitor moved into equin)

The fs-latency **monitor** is no longer here: it is equin's
[`io-health/plugins/monitor`](../../../plugins/infra/plugins/host/plugins/io-health/plugins/monitor/CLAUDE.md)
— a binary run every 30 s by a login service `./equin start` installs, its
line typed against the app's tick schema, its log rotated into kept archives.
Install, root opt-in, what a tick holds, `report.ts`: see there.

What stays here are two on-demand tools, below: `census.py` and
`fseventsd-bisect.py`. Run them from the main checkout:
`MAIN="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"`.

## Who is churning, without root

```sh
/usr/bin/python3 -I "$MAIN"/sidequests/monitors/fs-latency/census.py --seconds 300 [--out "$EQUIN_SCRATCH/census.json"]
```

On demand, not a launchd job. Once a second it reads every process's
unix-syscall count and disk bytes read (both readable for the user's own
processes with no privilege) beside `vfs.vnstats.num_newvnode_calls`, then
ranks process kinds by syscalls / disk MB with their correlation to new
vnodes/s, and names the heaviest readers in the worst seconds. A proxy (neither
counter is a vnode count; processes under ~1 s and root daemons are missed);
`fs_usage` in the root mode above is the exact answer.

## Which client makes fseventsd replay its history (root, on demand)

```sh
sudo /usr/bin/python3 -I "$MAIN"/sidequests/monitors/fs-latency/fseventsd-bisect.py [--fseventsd]
```

The `fseventsd_logs` field shows fseventsd cycling through old log files, a
history replay for some client. `fseventsd-bisect.py` names the client. It
watches one cycle (6 min) with fseventsd's debug logging on, recording a
`log stream` and dating the replayed range from the log files' mtimes. Then it
restarts each suspect in turn (`SUSPECTS`, launchd respawns them all) and
watches another cycle. The first restart after which no replay is seen gives the
verdict. `--fseventsd` adds a restart of fseventsd itself as the last step,
which proves the mechanism but names no client. Writes
`captures/fseventsd-bisect-<stamp>.json` and `captures/fseventsd-debug-<stamp>.log`.
Takes 6 min per step, at most 24 min.

Its 2026-11-04 run named no client (every suspect restart left the replay
running); the unified log did. **The client is `corecaptured`** (CoreCapture,
Apple's Wi-Fi/Bluetooth diagnostics daemon). On every launch its CacheDelete
client calls `_CacheDeleteEnumerateRemovedFiles` for `/Library/Logs/CoreCapture`
and `/Library/Logs/CrashReporter/CoreCapture`, which opens an FSEvents stream
from its saved purge marker (`com.apple.corecaptured.purge.purge_markers`) and
reads the whole history from there. Neither directory exists, so no event ever
matches and the marker is saved back unchanged after `historyDone`; it exits,
and launchd relaunches it at once (`because xpc event`). See it without root:

```sh
/usr/bin/log show --last 15m --predicate 'process == "corecaptured" AND (eventMessage CONTAINS "Time taken" OR eventMessage CONTAINS "consuming stream" OR eventMessage CONTAINS "setPurgeMarker")'
```

`consumeStream Time taken` is one replay (seconds); `consuming stream … from
ID:` is the marker it replays from.

**Fixed 2026-11-04 16:23 UTC** by restoring the two stock directories (root):
`sudo mkdir -p /Library/Logs/CoreCapture /Library/Logs/CrashReporter/CoreCapture`.
The replay running at the time saved a new marker on finishing (1839631885 →
3727846510), the next launch replayed for 0.11 s instead of 294 s, and
corecaptured then exited idle and stayed down (`launchctl print
system/com.apple.corecaptured`: `runs` stopped growing at 549). If the loop comes
back (`corecaptured` age cycling under ~300 s, fseventsd near 100 % CPU at idle),
check first that the directories still exist.

