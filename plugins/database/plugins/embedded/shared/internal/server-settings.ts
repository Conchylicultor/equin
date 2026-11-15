import { z } from "zod";
import {
  queryRows,
  type SqlQueryable,
} from "@plugins/database/plugins/sql-rows/core";
import { MAX_CONNECTIONS } from "./paths";

const MB = 1024 * 1024;

/**
 * The cluster's buffer cache, the one memory every database on it shares.
 *
 * Sized to the working set, measured on the dev machine on 2026-11-15
 * (task-1794712858-a1qjk5): main's database is 2.6 GB, 770 MB of it outside
 * its three append-only archives (traces, mail_messages, chord_loop_windows),
 * its hot tables (tasks, conversations, notifications, conversation_turns,
 * live_state_*, page_blocks, slow_ops…) about 300 MB — and every running
 * worktree backend reads its own copy of the same tables (7 databases had
 * sessions at once). On initdb's 128 MB the cache held none of that: in 10
 * days `tasks` (37 MB) was read back from the OS 42.7 M times (325 GB, its
 * whole size ~9,000 times over), `attempts` (2 MB) 2.8 M times; and the
 * autovacuum launcher's visit to each of the ~490 databases once a minute
 * pulls ~60–90 cold catalog pages each, evicting more buffers (432 M) than
 * every client backend together (297 M) — at ~800 evictions/s, a full
 * turnover of 128 MB every ~20 s, so nothing read less often than that stays.
 *
 * 1 GB holds main's whole non-archive set plus the hot sets of the running
 * worktrees, and makes one clock sweep take minutes instead of seconds, so a
 * page read every few minutes stays. Not more: what main reads past it is the
 * archives, scanned rarely, and the OS page cache behind the cluster still
 * serves a miss. Bounded by the machine's RAM (1/16, never under initdb's
 * 128 MB) so a packaged install on a small laptop does not reserve a gigabyte
 * of memory it shares with builds, browsers and agents.
 */
const SHARED_BUFFERS_MAX_BYTES = 1024 * MB;
const SHARED_BUFFERS_MIN_BYTES = 128 * MB;

/** `shared_buffers` for a machine with `ramBytes` of memory, in whole MB. */
export function sharedBuffersBytes(ramBytes: number): number {
  return Math.min(
    SHARED_BUFFERS_MAX_BYTES,
    Math.max(SHARED_BUFFERS_MIN_BYTES, Math.floor(ramBytes / 16 / MB) * MB),
  );
}

/**
 * The settings Postgres reads only when the postmaster starts, for a machine
 * with `ramBytes` of memory — passed on its command line by the start script
 * (`-c name=value`, which wins over `postgresql.conf`). A changed value
 * reaches a running cluster only on its next full restart: a reattach cannot
 * apply it, so the start script says which differ (`pendingServerSettings`)
 * instead of letting the difference go unseen.
 */
export function clusterServerSettings(
  ramBytes: number,
): Readonly<Record<string, string>> {
  return {
    max_connections: String(MAX_CONNECTIONS),
    shared_buffers: `${sharedBuffersBytes(ramBytes) / MB}MB`,
  };
}

const PendingRow = z.object({
  name: z.string(),
  running: z.string(),
  wanted: z.string(),
});
export type PendingServerSetting = z.infer<typeof PendingRow>;

/**
 * The entries of `wanted` the running cluster has another value for, both in
 * the cluster's own spelling (`current_setting`: `128MB`, `500`). A setting
 * counted in bytes compares as bytes (`1GB` = `1024MB`); every setting here is
 * a count or a size — a time-valued one would need its own comparison.
 */
export async function pendingServerSettings(
  client: SqlQueryable,
  wanted: Readonly<Record<string, string>>,
): Promise<PendingServerSetting[]> {
  return queryRows(client, {
    sql:
      "SELECT s.name, current_setting(s.name) AS running, w.value AS wanted " +
      "FROM pg_settings s " +
      "JOIN unnest($1::text[], $2::text[]) AS w(name, value) ON w.name = s.name " +
      "WHERE CASE WHEN s.unit IS NULL THEN current_setting(s.name) <> w.value " +
      "ELSE pg_size_bytes(current_setting(s.name)) <> pg_size_bytes(w.value) END",
    params: [Object.keys(wanted), Object.values(wanted)],
    row: PendingRow,
  });
}
