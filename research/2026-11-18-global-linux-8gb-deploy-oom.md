# An 8 GB Linux host: main's deploy OOM-killed, and the gateway service with it

2026-11-18. Fresh Ubuntu 24.04 Tart VM, 8 GB RAM, 4 CPUs. Main's second deploy
(the first update after an install) had a 2.8 GB bun process in its check pass
OOM-killed; the gateway's systemd user service stopped as a whole, which
SIGTERMed the build (`BUILD ABORTED`, exit 143). With 16 GB the same deploy
passed. Evidence of that run: `~/equin-vm-runs/chromium-font/`
(`deploy-main.log`, `gateway-main-deploy.log`).

## 1. Why one OOM kill stopped the whole service

A systemd service's `OOMPolicy` defaults to `stop`: an OOM kill of ANY process
in the unit's cgroup stops the unit (`Result=oom-kill`), and `Restart=on-failure`
brings it back 10 s later. The gateway's unit holds every backend, Postgres,
PgBouncer, every agent and every build/check a backend or agent spawned, so any
one of them running out of memory was an outage of the whole app.

Measured on Ubuntu 24.04 / systemd 255 (a user unit `KillMode=process`,
`MemoryMax=300M`, one child allocating until killed):

| unit | after the child's OOM kill |
|---|---|
| default (`OOMPolicy=stop`) | main process SIGTERMed, `Result=oom-kill`, `auto-restart` |
| `OOMPolicy=continue` | `active (running)`, same main pid |
| default, then `OOMPolicy=continue` written + `daemon-reload` (no restart) | `active (running)`, same main pid — the policy reaches a running unit through a reload |

The incident's signature matches: the gateway log shows a `gateway boot`
convergence run 16 s after the build's SIGTERM (stop + `RestartSec=10`).
`systemd-oomd` would have SIGKILLed the whole cgroup instead; the build reported
a SIGTERM.

Fix (pushed): `OOMPolicy=continue` on the gateway's login-service unit and on
the release unit; op processes (build / push / check / test / run) raise their
own `oom_score_adj` to 800 (Ubuntu's user manager puts every user process at
+200), so the kernel kills tooling before the gateway, Postgres or a backend;
systemd's `write` of a changed unit runs `daemon-reload`, and the gateway
follow's launch key covers the unit's policy keys, so installed gateways pick
the line up without a restart.

## 2. Where the memory goes — per step, measured

16 GB VM, main @7223a2756b, `install.sh --terminal`, then a commit on main
(a research `.md`) triggering the deploy; one sample per second of every
process's RSS and PSS. Raw data and the analysis script:
`~/equin-vm-runs/memsplit/`.

Baseline before the build: 1.96 GB RSS (0.90 GB PSS) — Postgres ~1.2 GB RSS but
~0.26 GB PSS (shared buffers), backends ~0.5 + 0.6 GB.

Run 1 — cold type-check (the install's build had linked this code already, so
the web-artifacts link was reused):

| step | peak total RSS (PSS) | top holders, GB RSS |
|---|---|---|
| codegen + web artifacts | 3.53 (2.28) | orchestrator 1.20, postgres 1.37, backend 0.63 |
| parallel tree checks (first ~70 s, ~60 checks at once) | 8.39 (6.80) | **check child 4.27**, postgres 1.35, tc-worker 1.04, orchestrator 0.80 |
| type-check program build/check | 8.00 (6.84) | tc-worker 3.23, check child 1.96, postgres 1.16 |
| type-check lint batches 1–9 (one at a time, ~30 s each) | **11.20 (9.99)**, MemAvailable 4.98 GB | **tc-batch 4.95**, check child 1.96, tc-worker 1.48 (idle beside its batch), postgres 1.18, orchestrator 0.78 |
| checks tail | 8.58 | tc-worker 4.05, check child 1.96 |
| deploy | 2.93 | postgres 0.95, orchestrator 0.80 |

Run 3 — a `.tsx` comment edit (link ran, type-check warm): the orchestrator went
1.1 → 3.8 GB footprint during `artifacts:link` (rolldown over 7,222 modules,
1.8 s) and kept ~3.0 GB RSS until it exited; the bundle IS closed — the heap is
simply not returned. Peak 8.61 GB: orchestrator 3.02, check child 1.63.

The incident's deploy did both at once: a cold check pass AND a relink, run in
parallel ("Running checks, type-checking, and building frontend in
parallel"). Summed (not measured in one run): ~10.6 GB in the first check
minute (the 2.8 GB bun killed fits the check child's 2.1–4.3 GB there), ~13.4 GB
in the lint batches.

## 3. What the push changed for memory, and what it did not

**The grant was spent twice.** A build took one host CPU grant (on 8 GB,
`B = 1`: one 3.6 GB quantum) and handed the WHOLE grant to its check child via
`grant.env()`, while its own web-artifacts pipeline spent the same unit in
process. So the check pass's type-check fleet and the link's 3 GB ran side by
side on a budget sized for one of them. `Grant.env()` is gone: `grant.run(fn)`
hands `fn` a `GrantShare` naming exactly the units it holds, and the build
splits its grant — the check pass `ceil(units / 2)`, the frontend the rest
(≥ 1). A one-unit build now runs its checks, then its frontend: the
orchestrator's 3 GB link heap no longer sits beside the check pass (−2.2 to
−3.0 GB at the peak). Cost: on `B = 1` the build's wall time is checks + frontend
instead of their max; from `B = 2` (16 GB) up they still overlap.

**Still too big for 8 GB:** a COLD check pass alone peaks at ~8.7 GB RSS (~7.6
GB PSS) of its own on top of the app's ~2.5 GB RSS — it does not fit in 8 GB
whatever runs beside it. Its parts, each a separate follow-up:

- the first update after an install type-checks the whole repo cold (17,956
  sources, 9 batches of ≤ 2,000) — backlog task-1795006239-dae69p;
- the type-check worker holds 1.5–2.6 GB idle while each batch process runs
  (and 4.05 GB after the last);
- the check child's first minute (~60 checks unbounded in parallel) peaks at
  4.27 GB, then holds 1.96 GB to the end;
- the orchestrator keeps ~3 GB after the link until it exits.

What the kernel now kills on such a host is the check pass (its build fails,
loudly) — never the app.
