import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

// Every retry is logged, persistently. The retry self-heals transient contention
// (DDL vs reads) but is NOT silent: a recurring deadlock — e.g. a genuine
// lock-order bug — surfaces here as a steady stream of lines even while it keeps
// succeeding within the cap, instead of vanishing. Grep `db.jsonl` for
// `[deadlock-retry]`; a rising rate is the signal to fix the source, not the cap.
// Durable "db" log. `defineLogSink` registers the channel env-free and defers
// the file-sink (its per-worktree path resolution) to first publish, so
// importing @plugins/database/server stays import-safe. It also carries every
// connection's `[deadline]` lines, written by `database/query-deadline`'s sink
// handler — the connection plugin stays below log-channels.
export const dbLog = defineLogSink({
  id: "db",
  description:
    "Database log: the app pool's transient-contention SQL retries ([deadlock-retry]) and, on every backend connection, calls that got no reply within their deadline ([deadline]); read via db.jsonl.",
});
