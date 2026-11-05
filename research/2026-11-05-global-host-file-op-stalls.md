# Simple file ops stalling 3–12 s on the host: what was measured

Task: task-1793832103-6s0uii (from the supervisor audit task-1793826400-nd8if7).
Targets: the **Event-loop stall** report family (`event-loop-stall:*`) and the slow-boot
"never became ready … superseded" family (`boot-wedge:*`).

No root on the machine, so no kernel stacks (`spindump`, dtrace and `fs_usage` refuse). The
evidence comes from:

- a 10 Hz C probe at known I/O tiers, timing each op beside its own thread CPU and kernel
  run state;
- reading main's threads with `proc_pidinfo`, and `sample` of main taken by the probe at a
  stall;
- the `fs-wait` channel (every fs call of ≥ 100 ms, per process);
- controlled reproductions.

**Measured** and **inferred** are kept apart below.

## The hypothesis we started from does not hold alone

"Vnode-cache thrash makes simple ops slow" was the hypothesis. It is not enough on its own.

- **Measured.** A probe at main's tier (utility QoS) ran ~40 min at load 20–60, with
  `kern.num_vnodes == maxvnodes` and 2–68k new vnodes/s. It saw **no** op ≥ 1 s:
  - hot `stat` / `realpath` / `open+read` / `readdir` / `create` stayed under 32 ms;
  - **cold** `stat` / `open+read` of a random file in a random worktree (almost always a
    vnode miss) had p50 ~4 ms and p99 ~220 ms.
- **Measured.** I/O tier does not explain the gap. utility and IOPOL_IMPORTANT read
  identical cold tails at the same instants. IOPOL_THROTTLE (darwinbg) adds a ~100 ms
  floor to every cold read (p50 104 ms).
- **Measured.** Memory pressure is not the stall either. `vm.page_free_wanted > 0` held in
  24 % of ticks, yet a utility thread's fresh anonymous page touch never passed 12 ms.

## What the stalls are

### 1. Most "stalls" are a loop of ordinary misses on main's event loop (measured)

Per-call times (`fs-wait`) and the code show that most event-loop-stall fingerprints are
**one synchronous walk over every worktree directory**, not one stuck syscall:

| fingerprint | what runs | how often |
| --- | --- | --- |
| `openSync`/`readSync ← readTail ← readChannelJson ← readBootEvents` | `boot-watchdog`'s job: tail-read each of ~240–300 `~/.equin/worktrees/*/logs/boot.jsonl`, sync | every minute, on main |
| `readFileSync`/`realpathSync ← … ← scanCheckout` | `spec.json` + `realpath` of every worktree dir | every browser-MCP target resolve |
| `scanGlob ~/.claude/projects/*/<id>.jsonl` (2.8–15 s) | a glob over ~1,664 project dirs per transcript lookup | status-reconcile, transcript-watcher |
| `readdir` 2–13 s under `~/Downloads/…` | `midi-folders:reconfigure` walks `~/Downloads` (26k dirs, 50 GB, incl. an old worktree backup) | at every backend's boot |
| `readFile` at `concurrent=64` | boot fan-out onto an 18-thread pool: queue time, not disk | every main boot (71 on 2026-11-04) |

Replaying `boot-watchdog`'s sweep outside main costs **110 ms** (0.5 ms per dir, 3 ms warm)
at load 50. Inside main it shows as 4–7 s. A main stall sampled by the probe (2026-11-05
00:00:24, 2.5 s) had main's thread mostly **on CPU** (thread CPU ≈ wall), with short
uninterruptible waits that lined up with rename stalls (§2).

So the cost is **N × (a miss made dearer by the fleet's churn) + main's own CPU**. N is the
lever. That is the lifecycle / transcript-lookup / boot-watchdog tasks' work, not a kernel
mechanism.

### 2. Renames are serialized volume-wide while a tree is mutated in bulk (measured)

This is the one real kernel wait. It explains `renameSync ← writeAtomic` (document-head)
and `renameSync ← cloneNamedBinary`.

- **In the wild (sample at 2026-11-04 23:18:07 UTC).** The probe's thread and main were
  both in `__rename`, in different directories, for 0.75 s and then 1.3 s, kernel state
  `U`. `create` + `unlink` in the same directory stayed fast; load was 18,
  `page_free_wanted` 0. In `U` at that moment: `bun install --frozen-lockfile` (a worktree
  install), main, an agent.
- **Reproduced** with a real `bun install --frozen-lockfile --ignore-scripts` of this repo,
  into a scratch tree, warm cache. The probe renamed a file in a disjoint directory:

  | window | probe rename p99 / max | other ops |
  | --- | --- | --- |
  | quiet | 2–14 ms max | unaffected |
  | darwinbg install (**80–90 s**) | ~200 ms / 530–990 ms | unaffected |
  | foreground install (**5–11 s**) | one stall of 287–1030 ms | unaffected |
  | darwinbg `rm -rf node_modules` (42–169 s) | 158–229 ms / 461 ms | unaffected |

  IOPOL_IMPORTANT renames were held just as long: priority does not help the waiter.
- **Synthetic.** Four throttled workers moving directories between parents: 339 ms. The
  same work at default tier was 3× faster and held no rename (14 ms). File renames or
  creates at the throttled tier held nothing.
- **Inferred mechanism.** A volume-level rename lock is held across the holder's
  directory-tree mutation. That is XNU's mount rename lock for cross-parent directory
  renames, and/or APFS's own serialization; no kernel stack confirms which. A darwinbg
  holder stretches it twice: its I/O is throttled while it holds the lock, and the whole
  install runs 8–16× longer, so it holds the lock many more times.

### 3. resvg parsed every system font on each icon render (measured, fixed)

`Resvg ← appIconPng`: 33 events, **18 a day**, the largest share of the family. resvg-js
loads system fonts by default. Every `new Resvg()` enumerated and parsed each font file,
**3.5 s** per render cold and 105 ms warm, against 0.1–0.3 ms without. The app icon draws no
text. The PNG cache is per process and main restarts ~70 times a day, so each restart paid
this again for every icon size.

## Attribution per fingerprint (event-loop-stall, last 7 days)

| fingerprint (group) | fires | rate | mechanism | status |
| --- | --- | --- | --- | --- |
| `Resvg ← appIconPng` | 33 | 18 a day | §3: system-font parse per render | **fixed here** |
| `openSync`/`readSync ← readTail ← readBootEvents` | 15 | 11 a day | §1: boot-watchdog's sync O(worktrees) sweep every minute | task-1793837742-hxy0up |
| `readFileSync`/`realpathSync ← … ← scanCheckout` | 7 | 6 a day | §1: O(worktrees) sync scan per browser-MCP resolve | task-1793837742-hxy0up |
| `renameSync ← writeAtomic` / `← cloneNamedBinary` | 10 | 2.5 a day | §2: volume rename serialization held by bulk tree mutations | task-1793837725-vv8ch3 |
| `readdirSync ← liveAgents`, `statSync ← pruneArtifactsInDir`, `statSync ← fileStamp` | 3 | — | §1 by shape (a sync loop over dirs) | **inferred**, not replayed |
| `require` chains (`debug`, `espree`) | 2 | — | module loading during a main boot under load (main booted 71× on 11-04) | **unexplained** per op; task-1793837733-04ncmy |
| `resolveSync ← resolvePlaywright` (15 s) | 1 | — | — | **unexplained** (one event) |

The `boot-wedge` "never became ready … superseded" family is not attributed here beyond
two points:
- its boots pay the same §1 / §2 costs, plus their own fan-out;
- main's restart rate is task-1793837733-04ncmy, and boot readiness is
  task-1793832188-qposgl.

**Not explained by any probe.** Why a 110 ms sweep reads 4–7 s inside main. A sample of one
2.5 s main stall showed mostly on-CPU time, with a few short `U` waits. Main's own CPU and
in-process contention look likely, but that is not measured.

## Who churns the vnode cache (census, 289 s, 2026-11-05 00:57)

New vnodes averaged 16k/s, with peaks of 68k/s. Leading kinds, by syscalls and disk MB:
- agents' and builds' `bun` processes, `./equin build`, `rg`, `git prune` (4.3 M syscalls);
- main's own boots, postgres, `./equin check` / `test`.

In the worst seconds: darwinbg `./equin check` runs, `./equin build` of main,
`regen-generated`, and an agent's `rg … ../../../../../../../`, which searched the whole home
directory. **Every agent shell is darwinbg** (`spawn-priority`'s `backgroundShellPrefix`),
so every agent `check`, `test`, `rg`, `git` and install pays the throttle floor and runs
long.

## What changed here

- **resvg.** `font: { loadSystemFonts: false }` on both renderers. The release DMG caption
  names its two macOS fonts with `fontFiles`; checked that the caption still renders. Lint
  `app-manifest/no-resvg-system-fonts` requires it on every `new Resvg`.
- **The fs-latency monitor**, so the next stall names its cause:
  - each tier ends with a burst of 20 renames (`rename_max`);
  - each tick records the processes in uninterruptible wait (`uninterruptible`);
  - a rename over 1 s sets `stall`, so the root daemon takes its `fs_usage` capture,
    which names who was renaming and removing;
  - a new detector rule, `rename-stall` (> 250 ms on ≥ 3 ticks an hour), files a
    `host-io-degraded` report naming the blocked processes.

## Proposed to the sibling tasks (their levers)

- **Worktree lifecycle.** Spare refill and removal mutate whole trees (`bun install`,
  `rm -rf`) under darwinbg. Each holds every rename on the volume for 80–170 s instead of
  5–11 s. Fewer of them, or ones that do not hold the rename lock (e.g. a rename of the
  whole tree to a trash dir, deleted later in one place), shrink this directly.
- **boot-watchdog / slow boots.** The per-minute sync sweep over every worktree's boot
  log on main's event loop is O(worktrees) a minute. Read only live namespaces, or follow
  the logs.
- **Transcript lookup.** Already filed: glob over 1,664 project dirs.
- **Repo-wide checks.** darwinbg costs ~100 ms per cold read; 64–129 concurrent reads per
  check. The run is long, so ~19 overlap.
- **midi-folders.** Every backend walks `~/Downloads` (26k dirs) at boot.

Probe sources and logs: `/tmp/stallinv/` (not kept).
