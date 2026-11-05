# prototypes.list from per-folder records; "stale tab" only when the bundle can explain it

Task: task-1793832122-6kopmf (from the 2026-11-04 supervisor audit, task-1793826400-nd8if7).

## What was measured (main, 2026-11-04)

- `loader prototypes.list`: 50 slow loads on 11-03/04, p50 4.3 s, p90 8.7 s,
  max 24.3 s (`slow-op-markers.jsonl`). The 2026-10-30 memo had already
  removed the re-read of every folder's bytes; what was left was the walk:
  per read, one root listing plus a stat and a listing of each of 132
  folders (the listing stats every file) — ~570 file system calls, one
  after another. On a host where a stat takes 100–250 ms
  (`fs-wait.jsonl`, caller `loader prototypes.list`), that is the 5–24 s.
- How often: every subscription that opens the tuple after it was torn down
  (the conversation view's prototype section, the page block, the gallery,
  the active-data chip all read the whole list and assume it is free), plus
  every watcher event, which also re-walked the whole tree for its
  signature gate.
- Why it hurt others: a running loader holds a read-admission slot.
  `read-admit` dominates the waits of the subs that went unanswered beside it
  (`attempts`, `tasks`, `attempt-work`, `plugin-view.tree`), so a slow
  `prototypes.list` delayed them too — the "unanswered-sub" wedge report
  (report-1793702756-fycp6b) names whichever sub was oldest.

## Fix 1 — the list is composed from records the watch moves

`server/internal/records.ts`: one record per folder (its listing, and its
scan once a list asked). The watch names the folders that moved; a refresh
re-lists only those. A list makes no file system call except the first read
of a folder that moved since the last list.

The one cross-folder dependency was validation's "references another
prototype's folder": it needs the set of sibling names, so any mint or
removal invalidated every folder (the old memo keyed on the sibling list).
Validation is now split: `scanPrototypeFolder` (everything that depends on
the folder alone, plus each file's path tokens) and `problemsOf(scan,
siblings)` (the join, no text). `validatePrototypeFolder` is their
composition, so the check and the CLI read exactly as before.

Not done, deliberately: persisting scans across restarts. The first list
after a backend boot still reads every folder's text (11.7 MB, bounded to 8
folders at once); every later list is O(changed).

## Fix 2 — "stale tab" is a claim about the cause

`staleOrigin` was "the tab's bundle graph ≠ the server's graph". Main
redeploys many times a day and tabs live for days, so nearly every report a
long-lived tab files is "stale" — including a wedge report, which is about
what the tab saw the SERVER do. A bundle's age cannot explain an unanswered
sub: the server answers an unknown key with `sub-error`, never silence.

Each client report source now states its subject (`CLIENT_REPORT_SUBJECT`
in `reports/core/sources.ts`, a `Record` over every source so a new one must
choose): `page` (the tab's own code — skew may explain it) or `server`
(`live-state-wedge`). `isStaleOrigin` is the one derivation the noise rule,
the bell's "(stale tab)" and the crash task's origin line read. The boot
noise backfill re-derives every row with it, so existing wedge rows stop
being muted as stale.
