import { CRON_RESOLUTION_MS } from "../../core/cron";

// How long a connection of the job queue's direct pools (`jobs-runner`,
// `jobs-enqueue`, `job-lock`) may sit idle before its pool closes it.
//
// The queue's work comes in waves, one a minute: graphile's cron ticks on the
// minute, and a tick's jobs are fetched, locked, run and completed at once — the
// runners' workers each check out their own `jobs-runner` connection for the
// fetch and the completion, and the tick's running jobs hold their locks on one
// `job-lock` session (job-lock.ts). So the
// connections one tick used are the ones the next tick needs.
//
// These pools dial Postgres directly (no PgBouncer: graphile LISTENs, the job
// lock is session-scoped), so a closed connection is a Postgres process the next
// use forks again — fork, auth, catalog warm-up, two log lines. Under pg-pool's
// default 10 s (`jobs-runner`, `jobs-enqueue`) and the 30 s `job-lock` had, every
// connection closed between two ticks and every tick reopened them all: ~140
// opens a minute host-wide on 2026-11-06 (69 `jobs-runner`, 60 `job-lock`, 8
// `jobs-enqueue`), nearly all of the cluster's connection churn.
//
// Two ticks, not one: a connection a tick used must outlive the gap to the next
// tick's use of it, which moves with how long each tick's jobs run. pg-pool hands
// out its most recently released connection first, so a steady tick keeps
// exactly the connections it uses warm, and one no tick has needed for two
// minutes — the extra a burst opened (boot, a backlog) — still closes. The pools'
// `max` (`2 × RUNNERS.length`, `TOTAL_JOB_SLOTS`, 10) still bounds what can be
// held; `job-lock` uses one of its `TOTAL_JOB_SLOTS` in steady state.
export const JOBS_POOL_IDLE_TIMEOUT_MS = 2 * CRON_RESOLUTION_MS;
