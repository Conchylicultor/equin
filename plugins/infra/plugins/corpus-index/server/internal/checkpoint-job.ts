import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { checkpointCorpusIndexes } from "./corpus-index";

// The journal cursor checkpoint of every corpus index (`checkpoint` in
// `corpus-index.ts`). A schedule, because what it follows has no change signal
// worth hearing: the FSEvents journal moves with every change on the volume
// (~300k events a minute here), and what a checkpoint saves is how far the
// live watch vouches for each root — so the next boot's catch-up replays at
// most two periods plus the downtime, where it replayed everything since the
// previous boot (24–44 s for the MIDI folders, 16 s for the transcripts).
// A tick is a drain of each watch, a re-check of what it named (already
// re-checked as it was heard, on the index's own watch) and one journal
// position per root — milliseconds.
//
// Main only (the default): every corpus index today is `host`-scoped, which
// only main persists; a checkpoint anywhere else skips.
export const corpusCheckpointJob = defineJob({
  name: "corpus-index.checkpoint",
  description:
    "Records how far each watched file index is known to be up to date, so after a restart it catches up only on what changed since, not on everything since the previous start.",
  // seconds: a re-check of the paths the watches named since the last tick,
  // bounded by the heavy-read slot like every corpus pass.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/5 * * * *" },
  async run() {
    await checkpointCorpusIndexes();
  },
});
