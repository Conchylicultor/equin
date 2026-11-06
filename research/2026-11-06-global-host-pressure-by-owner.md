# Host CPU / memory pressure, attributed by owner

Task: task-1793969193-bmvvuh (continues task-1793967902,
[`2026-11-06-global-host-cpu-oversubscription-audit.md`](2026-11-06-global-host-cpu-oversubscription-audit.md)).
Supervisor: task-1793965642-94fdhj.

## Question

The previous audit showed the 2026-11-05 contention window was memory pressure
(compressor 15–23 GB) plus darwinbg throttling, not CPU oversubscription, and
that the host CPU grant is greedy. It could not say **who** held the CPU and
memory: the host recorded totals only, and `debug/sentinel/machine-usage`
attributed on card open only. Step 1: make the next window attributable.
Step 2: with that data, decide memory admission and op-grant sizing.

## Step 1 — attribution, persisted

### What `ps` cannot see (measured)

The first attempt diffed each process's cumulative CPU time between two `ps`
readings. On a busy host it attributed **4.1 cores of 12.6 busy (23 %)**. The
gap is process churn: the host started **~30 processes a second** (308 pids in
10 s: Claude Code hooks, `git`, `rg`, test and type-check workers), and a
process that starts and exits between two readings is in neither.

macOS keeps that CPU: `proc_pid_rusage(RUSAGE_INFO_V1)` carries, per process,
the CPU of every child it has reaped (`ri_child_user_time` /
`ri_child_system_time`, each child's already including what it reaped). Read
at the same moment (2026-11-06 ~14:10 UTC): the gateway's own CPU was 337 s,
its reaped children's **17,600 s**; Postgres's postmaster 1,136 s own, 12,700 s
reaped. The times are mach units (125/3 ns here), scaled by
`mach_timebase_info`; user + system, scaled, matches `ps -o time` to the 10 ms.

A window then charges each live process `Δown + Δreaped − (last-seen totals of
its descendants that vanished)`. The subtraction must go to the nearest
**surviving ancestor**, not the direct parent: a process that exits rolls what
it reaped into its own parent. The first version subtracted direct children
only and charged one agent 31 cores and the gateway 16 cores (host busy: 8) —
main's backend had restarted, carrying its long-lived children's whole lives
into the gateway's reaped time.

| reading (2026-11-06) | host busy | attributed |
| --- | --- | --- |
| `ps` snapshots only | 12.6 cores | 4.1 (23 %) |
| + reaped children, direct-parent subtraction | 8.0 | 39.5 (wrong: 494 %) |
| + nearest-surviving-ancestor subtraction | 8.2 | **7.2 (88 %)** |

The rest: another account's processes (root daemons: their reaped children
are refused), orphans launchd reaps, the kernel (`kernel_task` 0.33 cores).

### Owners

Buckets (closed list, `MACHINE_USAGE_BUCKETS`): Chrome · agent ops · agent
browser · **agents** · **backends** · **Postgres** · other (new in bold).
Roots claim their subtree in precedence order: agent browser host → each
op marker's CLI pid → named roots (Postgres/PgBouncer by executable; the
`equin.app` bundle, i.e. the gateway and every backend under it;
`equin · server|central`; `equin · agent · conv-…` and its `equin · conv-…`
Claude Code) → Chrome by bundle → other. Names come from
`packages/process-name` (`processKindOf`, new, the inverse of `processName`).
An agent's `./equin build` stays the op's.

### What landed

- `packages/proc-rusage` (new): `readProcRusage(pid)` — footprint, resident,
  own CPU, reaped-children CPU; the one `proc_pid_rusage` binding
  (server-core's `bin/phys-footprint.ts` now reads through it). The host probe
  `peerProcMemory` became `peerProcUsage` (memory + CPU); machine-usage was its
  only reader.
- `machine-usage`: three new buckets, name-based roots, `summarizeOwners`
  (pure, tested), and on main a 30 s `machine-usage.owner-sampler` timer
  writing the `health-owners` log: per bucket `{processes, cpuCores, memMb}`
  plus the 12 largest processes (6 by memory, 6 by CPU) named. ~0.1 CPU-s
  per tick (one `ps` + ~1,000 `proc_pid_rusage`).
- Debug → Health: **Who uses the machine** — CPU by owner (cores) and memory by
  owner (GB footprint), stacked, beside the host's CPU busy %.
- `scripts/owners-now.ts`: the same breakdown on demand over a window, with
  the host's busy share beside the attributed one.

## Step 2 — what the readings say

Two readings during this session's own contention (2026-11-06 ~14:10–14:25
UTC; compressor 16 → **23 GB** of 64 GB, CPU 45 % busy, a duress hold on this
task's build for `decompressionsPerSec`):

| owner | CPU (cores) | memory (GB footprint) |
| --- | --- | --- |
| agents | 3.7–3.9 | **15–23** |
| Postgres | 0.1 | **12.5** (over-stated, see below) |
| agent ops | 1.5–2.5 | 9–14 |
| Chrome | 0.2–0.3 | 8 |
| other | 0.3 | 7 |
| backends | 0.5 | 4.4 |
| agent browser | 0.1–0.7 | 3.5 |

Largest processes: four `equin · run blocking-fs/scripts/inventory.ts` scripts
an agent started (**2.2–3.8 GB each, ~11 GB together**), type-check workers of
a `check` op (2.4–2.7 GB each).

**CPU is not the binding resource**: owners sum to ~7–8 of 18 cores. Memory is.

**Memory, by what admission covers:**

- Admitted ops (agent ops): 9–14 GB — the only bucket the host grant sees.
- Not admitted, and the largest: the agents' own commands. A plain
  `./equin run` script (not an e2e) takes no grant at all, and here four held
  ~11 GB at once. Agent Claude Code CLIs themselves are ~0.2 GB each.
- Not admitted: **Postgres idle connections.** 216 client backends across 13
  databases, **215 idle** (`pg_stat_activity`, main's cluster). Each holds
  ~50–65 MB private (`footprint`: `MALLOC_SMALL` 64 MB — relation/catalog
  caches for a large schema). Footprint also counts the `shared_buffers`
  pages (128 MB) each backend touched, so the bucket's 12.5 GB over-states;
  the private part is ~10 GB, held by connections doing nothing. By pool
  (`application_name`): `app-background` 59 (idle 176 s on average),
  `jobs-runner` 53 (idle 869 s), `app` 33 (261 s), `schema-generation` 9
  (idle **1,713 s** — one per backend, held ~28 min after use),
  `change-feed` 9 and `lock-watch` 9 (held sessions by design). About 23 per
  running backend, of which a handful work.

> **Correction (task-1793975219):** the Postgres numbers above are wrong by
> ~4–5×. Per-process footprint charges each backend for the shared segment it
> touched, and both the bucket and the "~50–65 MB private" read include it.
> Measured with `footprint`'s private categories and a per-region walk:
> **~2.2 GB private heap + ~0.2 GB shared once** (avg ~11 MB a session). Idle
> connections are not the second memory owner, and item 1 below is closed with
> no change. See
> [`2026-11-06-global-postgres-idle-connections-memory.md`](2026-11-06-global-postgres-idle-connections-memory.md).

**Decision (measured):** re-sizing the host grant's memory quantum (B = 9)
would act on the 15–20 % of the footprint that is admitted. The two biggest
unadmitted consumers are concrete and fixable at their source, so they come
first; memory admission of ops is not changed here.

1. Idle Postgres backends (~10 GB): why each running backend keeps ~23
   connections open — its app / background / jobs-runner pools and a
   schema-generation client idle for half an hour — when a handful are
   working. The question is what holds them (pool idle timeouts, a client
   never released), not a cap.
2. Unadmitted `./equin run` scripts (2–4 GB each). A script that is a heavy
   op in all but name gets no grant and no marker.

**Op fan-out — landed for `test`:** a test run's parallelism is exact — `bun
test` runs its files in one process, vitest one worker per file — so `./equin
test` now asks for `max(1, min(B, vitest files))` instead of `B`. Before: one
single-plugin run held all six background slots (previous audit), and this
task's own 1-second suites queued **370 s and 241 s** for a slot. `check` and
`build` keep `B`: their fan-out (type-check workers, vite) is real at their
peaks (a build's tree peaked at 2.6 cores), and sizing them wants the per-op
CPU now recorded in `health-owners` (agent-ops bucket) over a window.

## Before / after

| | before | after |
| --- | --- | --- |
| who used the CPU, then | not recorded | every 30 s, 7 owners, 88 % of busy CPU attributed |
| who held the memory, then | not recorded | every 30 s, footprint per owner + 12 named processes |
| CPU of short-lived processes | invisible (77 % of busy time) | charged to their parent's owner |
| a one-plugin `./equin test` | asks for 9 units, takes every free slot | asks for its vitest file count (≥ 1) |

The owner sampler runs on main only: its first contention window is read
after this lands.

## Memory owners, re-ranked on the corrected Postgres numbers (task-1793977698)

`health-owners`, main, 15:28–16:39 (140 samples, 30 s apart). Postgres scaled
by the measured ratio (2.7 / 11.4 GB, same minute):

| owner | median | p90 | max | note |
| --- | --- | --- | --- | --- |
| other | 19.1 | 20.8 | 21.3 GB | **a 12 GB `com.apple.Virtualization.VirtualMachine`** (gone by 16:29) — not an equin process |
| agent ops | 11.5 | 18.8 | 28.0 GB | type-check batch workers 2–7.6 GB, `check` / `build` CLIs ~2.8 GB |
| agents | 8.5 | 11.5 | 15.2 GB | |
| Chrome | 8.0 | 8.4 | 8.7 GB | |
| backends | 5.4 | 6.6 | 8.0 GB | |
| **Postgres** | **~2.7** | **~3.0** | **~3.4 GB** | was 11.2 / 12.7 / 14.0 GB (Σfootprint) |
| agent browser | 0.8 | 1.8 | 2.6 GB | |

So among what equin owns: **agent ops first** (and its tail — 28 GB — is the
type-check workers), then the agents, then the backends; Postgres is last
but one. Unadmitted `./equin run` scripts (2–4 GB each) did not appear in this
window. The earlier window's 15–23 GB for agents was not reproduced here (8.5
median).

## Follow-ups

- ~~Idle Postgres connections: ~23 per running backend, ~215 idle × ~50–65 MB.~~
  Investigated: ~2.4 GB real, every holder known. The sampler's Postgres
  bucket now counts shared memory once (task-1793977698): 11.4 → 2.7 GB.
- `./equin run` scripts are unadmitted against memory and CPU.
- Size `check` / `build` grant `max` from their fan-out, measured from
  `health-owners`' agent-ops bucket during a window.
