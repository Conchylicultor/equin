import { utimes } from "node:fs/promises";
import { z } from "zod";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { listRetainedConversations } from "@plugins/tasks/plugins/tasks-core/server";
import { resolveConversationTranscriptPaths } from "@plugins/conversations/plugins/transcript-watcher/server";

const log = Log.channel("transcript-retention");

// Claude Code deletes session JSONL transcripts whose mtime is older than
// `cleanupPeriodDays` (default 30). equin reads those files directly as
// the SOLE source of truth for conversation content — it never copies them
// into Postgres — so an active-but-idle conversation would silently lose its
// transcript once 30 idle days pass. Touching every retained conversation's
// JSONL daily keeps its mtime fresh, well inside the window, and keeps
// `claude --resume` working (resume reads the same file).
//
// "Retained" = active, PLUS every conversation of a HELD task whatever its own
// status. Holding is the user parking work they mean to resume, and the "Hold &
// close" flow closes the conversations on the way out — so scoping to `active`
// would age out exactly the history a hold was meant to preserve. Closed
// conversations of non-held tasks are still left to age out, so this stays
// selective and never bloats disk.
//
// EVERY file of the conversation's session chain is touched, not just the live
// tail: the read path merges the whole chain, so an ancestor Claude GC'd would
// erase the history it contributes.
export const transcriptTouchJob = defineJob({
  name: "conversations.transcript-touch",
  description:
    "Refreshes the transcript files of retained conversations so Claude Code never deletes their history for age.",
  // seconds: filesystem metadata only, but N is the whole retained set and
  // resolving each session chain glob-scans the Claude projects dir on a cache
  // miss — nothing bounds it to the `instant` ceiling.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 4 * * *" }, // daily at 04:00 UTC
  async run() {
    const now = new Date();
    let conversations = 0;
    let files = 0;
    for (const conv of await listRetainedConversations()) {
      const paths = await resolveConversationTranscriptPaths(conv.id);
      if (paths.length === 0) continue;
      for (const path of paths) {
        await utimes(path, now, now);
        files++;
      }
      conversations++;
    }
    log.publish(
      `touched ${files} transcript file(s) across ${conversations} retained conversation(s)`,
    );
  },
});
