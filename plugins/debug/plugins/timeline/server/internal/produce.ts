import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import { listLiveForkDatabases } from "@plugins/debug/plugins/slow-ops/plugins/cluster/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { HOST_LANE, type TimelineFrame } from "../../shared/frames";
import { DB_SOURCES } from "./sources/db-sources";
import type { DbSourceCtx } from "./sources/context";
import { loadBootEvents } from "./sources/boot";
import { loadDuressEpisodes } from "./sources/duress";
import { readHealthLane, readHostLane } from "./sources/health";
import { listWorktreeLogDirs } from "./log-dirs";

// Same bound as the cluster tab's fan-out: each short-lived pool is `max: 1`,
// so this caps the backends we add to the (possibly already-contended)
// cluster while still parallelising the merge.
const FANOUT_CONCURRENCY = 6;

// This view gets opened DURING incidents. A saturated fork must produce an
// error chunk within seconds, not hang the scan — every fan-out session
// sets this before its first query.
const STATEMENT_TIMEOUT_MS = 10_000;

type Emit = (frame: TimelineFrame) => void;

// The fan-out across ~16 fork DBs can take tens of seconds under load, so it
// emits a determinate `{ total }` up front, then one frame per (source,
// worktree) cell as it resolves. Two consumers drive it with their own emit:
// the web tab's live scan (scan-served.ts — folds the frames into the
// `debug.timeline.scan` value and pushes it as they arrive) and the in-process
// get_timeline MCP tool (collect.ts — collects them into a rendered text
// report). Callers run it under the background lane with profiling suppressed
// — observability must never feed the profiler or ride the interactive lane
// (anti-amplification discipline).
export async function produceTimeline(
  emit: Emit,
  fromMs: number,
  toMs: number,
): Promise<void> {
  // Which forks count as live is judged at the window's end — the question's
  // `at` for the web scan — so one question always reads one fork set, however
  // often its scan restarts.
  const dbNames = await listLiveForkDatabases(toMs);
  const logWorktrees = listWorktreeLogDirs();
  // Planned chunk count: every (DB × DB-source) cell, one boot chunk per
  // worktree log dir, plus the single host-global duress chunk. Health frames
  // are series, not chunks, and don't count.
  emit({ total: dbNames.length * DB_SOURCES.length + logWorktrees.length + 1 });

  const semaphore = createSemaphore(FANOUT_CONCURRENCY);
  const dbWork = Promise.all(
    dbNames.map((dbName) =>
      semaphore.run(() => emitDbChunks(emit, dbName, fromMs, toMs)),
    ),
  );

  try {
    // Disk-backed lanes (cheap main-local reads) while the DB fan-out runs.
    for (const worktree of logWorktrees) {
      try {
        const events = loadBootEvents(worktree, fromMs, toMs);
        emit({ chunk: { source: "boot", worktree, ok: true, events } });
      } catch (err) {
        // Loud-but-resilient, like the per-DB cells: one unreadable boot.jsonl
        // must not blank the whole timeline.
        emit({
          chunk: { source: "boot", worktree, ok: false, error: String(err) },
        });
      }
      const samples = readHealthLane(worktree, fromMs, toMs);
      if (samples.length) emit({ health: { worktree, samples } });
    }
    // Host-global duress episodes (one chunk on the host lane, read from
    // main's log dir — the sentinel worker is the latch's sole writer).
    try {
      const events = loadDuressEpisodes(fromMs, toMs);
      emit({
        chunk: { source: "duress", worktree: HOST_LANE, ok: true, events },
      });
    } catch (err) {
      emit({
        chunk: {
          source: "duress",
          worktree: HOST_LANE,
          ok: false,
          error: String(err),
        },
      });
    }
    const hostSamples = readHostLane(fromMs, toMs);
    if (hostSamples.length)
      emit({ health: { worktree: HOST_LANE, samples: hostSamples } });
  } finally {
    // Always drain the DB fan-out, even if a disk scan threw — otherwise its
    // late chunks would land after the producer resolved (a completed scan /
    // collected report) or reject unhandled.
    await dbWork;
  }

  emit({ end: true });
}

// Open the per-DB session and pin its statement timeout. Throws on any
// failure; the caller turns that into one error chunk per source.
async function openSession(pool: ReturnType<typeof openShortLivedClient>) {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
  } catch (err) {
    client.release();
    throw err;
  }
  return client;
}

async function emitDbChunks(
  emit: Emit,
  dbName: string,
  fromMs: number,
  toMs: number,
): Promise<void> {
  const ctx: DbSourceCtx = {
    dbName,
    isMainDb: dbName === MAIN_WORKTREE_NAME,
    fromMs,
    toMs,
  };
  const pool = openShortLivedClient(dbName);
  try {
    let client: Awaited<ReturnType<typeof openSession>>;
    try {
      client = await openSession(pool);
    } catch (err) {
      // The whole DB is unreachable (dropped fork, saturated cluster): one
      // error chunk per source keeps the client's progress accounting exact.
      for (const src of DB_SOURCES) {
        emit({
          chunk: {
            source: src.source,
            worktree: dbName,
            ok: false,
            error: String(err),
          },
        });
      }
      return;
    }
    try {
      for (const src of DB_SOURCES) {
        try {
          const events = await src.load(client, ctx);
          emit({
            chunk: { source: src.source, worktree: dbName, ok: true, events },
          });
        } catch (err) {
          // Per-cell isolation (statement timeout, old-schema fork, malformed
          // row): surface the error in that cell, keep the rest of the DB.
          emit({
            chunk: {
              source: src.source,
              worktree: dbName,
              ok: false,
              error: String(err),
            },
          });
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
