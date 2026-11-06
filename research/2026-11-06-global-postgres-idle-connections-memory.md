# Idle Postgres connections: what holds them, and what they really cost

Task: task-1793975219 (continues task-1793969193-bmvvuh,
[`2026-11-06-global-host-pressure-by-owner.md`](2026-11-06-global-host-pressure-by-owner.md)).
Supervisor: task-1793965642-94fdhj.

## Question

The previous step read main's cluster under memory pressure: 216 client
backends, 215 idle, "~50–65 MB private each, ~10 GB in total", making Postgres
"the largest memory owner after the agents". Why do the connections stay open
while idle?

## Answer, in short

1. **The ~10 GB is a measurement artifact.** Postgres's real memory was
   **~2.4 GB** (2.2 GB private heap across all 195 processes, plus the
   ~160–240 MB shared segment counted once). Summing each process's physical
   footprint counts the shared memory every backend has touched once per
   backend — up to ~156 MB each. The owner sampler (`health-owners`) does
   exactly that sum, so its Postgres bucket over-states by **~4–5×** (11.3 GB
   reported vs ~2.4–3.5 GB real, same minute).
2. **Every idle connection has a known holder, and none is a leak.** The
   pooled ones stay open until a timeout that is set (or left at the default)
   on purpose. The held ones are held by design and cost 4–8 MB each.
3. So idle Postgres connections are **not the next memory target**. The fix
   that matters is the instrument: a Postgres bucket that counts shared memory
   once (next task, below).

## 1. What a connection really costs

Read 2026-11-06 ~14:30–14:45 UTC, main's cluster, with `footprint` (Apple's
tool, which splits a process's memory into private and shared) and
`proc_pidinfo(PROC_PIDREGIONINFO)`.

### `footprint` per process double-counts shared memory

Run on two backends together, `footprint` lists their shared memory
separately ("Shared with postgres [69516]: 100 MB untagged (VM_ALLOCATE)").
Run on ONE backend, the same pages show up as that backend's own dirty
memory. The kernel's `ri_phys_footprint` (what `proc_pid_rusage` returns and
the sampler sums) does the same thing: it charges each process for the shared
pages it has touched.

| backend (pid) | `phys_footprint` | of which shared segment touched | private (malloc + rest) |
| --- | --- | --- | --- |
| 44940 (app-background, busy) | 222–235 MB | 154 MB | 68 MB |
| 51170 (checkpointer) | 146 MB | ~141 MB | 5.6 MB |
| 69516 (jobs-runner LISTEN) | 10 MB | 7 MB | 3.3 MB |

Postgres's own accounting agrees with the small numbers.
`pg_log_backend_memory_contexts` on three of the largest sessions:
`Grand total` **6.1 / 17.7 / 21.8 MB** of palloc'd memory. The rest of a busy
session's private part is the allocator keeping freed memory (the malloc
high-water mark of past queries).

### Every Postgres process, private part summed

Per process, the MALLOC categories of `footprint` (private by construction).
195 processes, 14:35 UTC:

| role (`usename`) | sessions | private heap | avg | max |
| --- | --- | --- | --- | --- |
| `singularity_background` (app-background lane) | 59 | **1,255 MB** | 21 MB | 73 MB |
| `singularity` (app, jobs, held sessions) | 128 | 817 MB | 6.4 MB | 51 MB |
| auxiliary (checkpointer, io workers, walwriter, …) | 8 | ~25 MB | | |
| **total private** | | **~2.2 GB** | | |

Plus the shared segment, once: 128 MB `shared_buffers` + 44 MB other main
shared memory + DSM segments (16 + 16 + 4 MB) ≈ 210–240 MB.

By pool (footprint's private part, earlier read of 148 sessions, same
method): `jobs-runner` avg **4 MB**, `change-feed` **7 MB**,
`schema-generation` **8 MB**, `lock-watch` 24 MB (it reads `pg_stat_activity`
every minute). The held, by-design sessions are cheap. The memory is in the
two app lanes' pooled sessions, and it follows what the session ran, not how
many sessions exist.

A second method, summing each process's private regions with
`proc_pidinfo(PROC_PIDREGIONINFO)` (`pri_private_pages_resident` +
`pri_pages_swapped_out` of COW / private regions), matches `footprint`'s
private part to <1 MB per process (68 vs 67.6, 3.3 vs 2.8, 5.6 vs 5.2 MB).
Over all 251–258 Postgres processes at a busier moment: **Σfootprint 11.7–12.2
GB vs Σprivate 2.5–3.2 GB + shared once 0.22–0.24 GB = 2.7–3.5 GB.**

### Is it only Postgres?

The same region walk over Chrome (38 processes): Σfootprint 8.09 GB, private
8.94 GB. Over the Bun backends (13): 5.47 GB vs 5.46 GB. **No over-count.**
Postgres is the one owner whose processes are forks of one parent sharing a
large anonymous segment.

## 2. What holds each kind of idle connection

`pg_stat_activity`, main's cluster, 2026-11-06 ~14:30 UTC (count, average
idle):

| pool | path | sessions | why it stays open |
| --- | --- | --- | --- |
| `app-background` | PgBouncer (tx mode), as `_background` | 50–59, idle avg 55–176 s, max ~595 s | PgBouncer **server** sessions. No `server_idle_timeout` in the rendered `pgbouncer.ini` → default **600 s**; `server_lifetime` default 3,600 s (oldest seen: 3,754 s). The lane bursts to its gate cap (`BACKGROUND_QUERY_MAX` 7 + `BACKGROUND_TX_MAX` 3 = pool_size 10) often enough that ~6–10 server sessions per database are touched every few minutes (idle_min 1 s in every database). `warmPool()` also opens all 10 at each backend boot. |
| `app` | PgBouncer, as the cluster user | 33–34, idle avg 261–324 s | Same 600 s server idle timeout; interactive pool_size 8, warmed to 8 at boot. Fewer bursts, so more of them sit idle toward the 600 s cut. |
| `jobs-runner` | direct | 48–88 (it moves a lot) | Two kinds. (a) Each runner's LISTEN client, checked out for the backend's life (1–3 per database, idle = age: 1,300–9,200 s). (b) Worker fetch/complete connections: pg-pool's **default 10 s idle timeout** (no `idleTimeoutMillis` passed in `worker.ts`) closes them, but every cron minute each backend's jobs reopen ~5 at once — 25 sessions aged 34 s in one read. Not held: **churned**. 7–102 new Postgres processes appear per 30 s, most of them these. |
| `job-lock` | direct | 4–49 | Advisory lock per running job, 30 s idle timeout. Follows the cron minute. |
| `schema-generation` | direct | 8–9, one per backend (2 for a backend with an exec child) | **By design**: a shared session advisory lock held for the process's life (`connection/server/internal/schema-generation.ts`). |
| `change-feed` | direct | 7–9, one per backend | **By design**: the LISTEN session. |
| `lock-watch` | direct | 7–9, one per backend | **By design**: a held session so a look still runs when new connections stall. |

So "~23 per running backend" is: ~10 + ~4 PgBouncer server sessions kept up to
600 s after a burst, 3 held sessions, 1–3 LISTEN clients, and a minute-periodic
burst of short-lived job connections.

### What is NOT the cause

- No client is "never released": the app pools release on every checkout (a
  lost client is closed by the deadline), and pooled clients idle out after
  20 s (`pg-driver.ts`). What lingers is PgBouncer's **server** side, which in
  transaction mode is decoupled from client connections.
- No idle pool is pinned by `min`: no pool sets one, and PgBouncer has no
  `min_pool_size` (deliberately: `lanes.ts`).

## 3. Decision

- **No change to connection counts here.** The idle sessions cost ~2.2 GB of
  private heap in total, against ~15–23 GB for the agents and 9–14 GB for agent
  ops in the same window. The only lever left (a shorter PgBouncer
  `server_idle_timeout`) trades ~1 GB for connection churn. That is a cap, not
  a cause, and the cause (bursts up to the lane caps) is the lane design
  working as intended.
- **Fix the instrument first.** The sampler's Postgres bucket over-states by
  ~4–5×, and Debug → Health charts it. That is what put idle connections at the
  top of this track's list. The previous step's table and decision are
  corrected in place.

### The instrument fix, as measured (next task)

- **Exact method:** for each Postgres process, sum the private pages of its
  COW / private regions (`PROC_PIDREGIONINFO`, resident + swapped out). Add each
  distinct shared object (`pri_obj_id`, modes SHARED / TRUESHARED /
  SHARED_ALIASED) once, by its dirtied pages. Validated against `footprint`
  above. Same user, no task port or entitlement needed.
- **Cost is the catch.** Each `PROC_PIDREGIONINFO` call costs 60–100 µs in the
  kernel (it computes the region's residency page by page), ~130–160 regions
  per backend. The whole Postgres tree takes **~1.6 s** of synchronous FFI at
  moderate load and up to 4.6 s at load average ~50. It cannot run on main's
  event loop every 30 s.
- Options to weigh: walk in a short-lived child or a `defineDaemon` worker;
  walk only processes new or with a changed footprint since the last walk
  (measured: 7–102 new + 39–81 changed of ~210–310 per 30 s, so ~½ saved);
  skip the postmaster's inherited shared ranges in each child's walk (it cut
  calls 33k → 21k, timing unproven under load).
- Only the Postgres bucket needs it: Chrome and the Bun processes show no
  over-count.

## 4. The instrument fix — landed (task-1793977698)

The sampler now measures the Postgres tree as described above, on a worker
thread (`machine-usage/machine/internal/fork-memory/`, documented in that
plugin's CLAUDE.md). Two refinements over the exact method, both measured:

- **The postmaster is the template.** A backend is a fork, so the ranges it
  inherited sit at the same addresses. The walk steps over the postmaster's
  shared-inherited segment (counted once, from the postmaster) and its
  read-only mappings. 2.2× fewer µs; 99.3 % of private pages kept (40
  backends: 440 vs 443 MB). Trap found on the way: in the postmaster its own
  malloc regions read as TRUESHARED (its children share them copy-on-write),
  so "skip what is shared in the parent" drops ~25 % of the children's
  private memory; the skip keys on inheritance = SHARE instead, and never on a
  protection-0 reservation (a child maps into it later).
- **A backend whose footprint and start did not move is not walked again**
  (about half change per 30 s).
- Shared objects counted once: every writable shared-mode region, by VM object
  id — the segment, the copy-on-write pages children still share with the
  postmaster, and a DSM segment only backends map.

**Check against Apple's `footprint -p postgres`** (shared pages once): 3,102
MB vs **3,058 MB** here, same minute.

**Before / after**, 2026-11-06 16:38, same minute:

| | Postgres bucket | top Postgres entries |
| --- | --- | --- |
| before (main's sampler, Σfootprint) | **11.4 GB** | backends at ~220–235 MB each |
| after (this build's Machine watcher card) | **2.7 GB** | postmaster ~260 MB (segment once), backends 5–75 MB |

Every other bucket read the same in both (Chrome 8.0 / 8.1 GB, backends 4.4 /
4.4 GB). Cost, off the event loop: 1.3 s cold, 0.7 s warm on the worker for
255–329 processes (load 15–30); the backend's loop only awaits a message.

## Side findings

- `~/.equin/postgres/postgres.log` is **1.85 GB** and growing: the cluster logs
  every connection (`log_connections = receipt,setup_durations`), and the job
  churn above opens several per second. Known debt: the running cluster
  predates the gateway's log relay, and the file moves into the relay's bounded
  rotation on the cluster's next fresh start (task-1793827129-t489g4). The
  job-connection churn is what makes it grow this fast.
- The `machine-usage` CLAUDE.md's "~50–65 MB per connection, catalog caches,
  is real" was wrong (corrected): private heap averages 11.5 MB, and the large
  ones are allocator high-water marks, not live caches.
