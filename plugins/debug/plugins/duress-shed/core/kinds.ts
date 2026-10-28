import { z } from "zod";

// The jsonb payload for a `duress-shed` report: one shed buffer's flush
// summary, filed by the buffer's consumer (trace capture / slow-ops / reports)
// after a duress episode clears. Structurally the shed engine's ShedSummary
// (consumers file `data: { ...summary }` verbatim — the server kind file
// carries a compile-time drift guard against the duress type). One report per
// (buffer, episode): the fingerprint keys on both, so summaries from different
// episodes or different buffers never dedupe onto each other.
export const DuressShedPayloadSchema = z.object({
  // The shed buffer's stable id ("traces" | "slow-ops" | "reports" today —
  // open by construction, any future buffer slots in).
  kind: z.string(),
  // `setAt` (epoch ms) of the latest duress episode that contributed to the
  // flushed batch; null when the latch was unreadable while buffering.
  episodeSetAt: z.number().nullable(),
  // Per cascade key: `shed` items were buffered and handed back through
  // replay after the episode (deferred, not lost — except traces, whose replay
  // is a documented accounting no-op); `dropped` items overflowed the bounded
  // buffer — the item is gone but the count survives.
  byCascade: z.record(
    z.string(),
    z.object({
      shed: z.number(),
      dropped: z.number(),
    }),
  ),
  replayed: z.number(),
  replayErrors: z.number(),
});
export type DuressShedPayload = z.infer<typeof DuressShedPayloadSchema>;
