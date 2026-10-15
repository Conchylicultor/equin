import { inArray, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { checkOembed } from "@plugins/integrations/plugins/youtube/server";
import type { VideoStatus } from "../../core";
import { _chordVideos } from "./tables";
import { chordVideoStatus } from "./views";

// ── The on-demand check ──────────────────────────────────────────────────────
//
// No sweep: a video is checked only when a loop query is about to offer it and
// nobody has a fresh answer for it. So nothing checks a video nobody will see,
// there is no backlog and no burst of traffic to YouTube, and an answer ageing
// past the TTL is re-checked lazily, the next time the video is offered.

/**
 * Most oEmbed requests in flight at once, across every caller of this backend.
 * The measurement ran 12 in flight with no throttling; 8 leaves room.
 */
const VIDEO_CHECK_CONCURRENCY = 8;

const gate = createSemaphore(VIDEO_CHECK_CONCURRENCY);
// Two loop queries offering the same video at once share one request.
const inflight = createInflight();

const videoCheckLog = defineLogSink({
  id: "chord-video-check",
  description:
    "Chord video availability: the oEmbed checks that got no answer (the video stays unknown and is offered) or a code that says nothing about the video.",
});

/** The view's status for each id; an id with no row is `unknown`. */
async function readVideoStatus(
  videoIds: readonly string[],
): Promise<Map<string, VideoStatus>> {
  const rows = await db
    .select({
      videoId: chordVideoStatus.videoId,
      status: chordVideoStatus.status,
    })
    .from(chordVideoStatus)
    .where(inArray(chordVideoStatus.videoId, [...videoIds]));
  const byId = new Map<string, VideoStatus>(
    videoIds.map((id): [string, VideoStatus] => [id, "unknown"]),
  );
  for (const row of rows) byId.set(row.videoId, row.status);
  return byId;
}

/**
 * Check one video over oEmbed and record the answer in oEmbed's own three
 * columns. A code that says nothing is recorded with a null status, so the
 * video stays `unknown` and is asked about again next time. No answer at all
 * records nothing.
 *
 * A failing write throws: that is our database, not YouTube, and fail-open
 * covers only the latter.
 */
async function checkAndRecord(videoId: string): Promise<void> {
  const check = await checkOembed(videoId);
  if (check.kind === "unreachable") {
    videoCheckLog.publish(`${videoId}: no answer (${check.reason})`, "stderr");
    return;
  }
  if (check.verdict.kind === "undecided") {
    videoCheckLog.publish(
      `${videoId}: oEmbed answered ${check.code}, which says nothing about the video`,
      "stderr",
    );
  }
  const observed = {
    oembedStatus:
      check.verdict.kind === "decided" ? check.verdict.status : null,
    oembedCode: check.code,
    oembedCheckedAt: new Date(),
  };
  await db
    .insert(_chordVideos)
    .values({ videoId, ...observed })
    // Only oEmbed's columns: the player's evidence is never touched here.
    .onConflictDoUpdate({
      target: _chordVideos.videoId,
      set: {
        oembedStatus: sql`excluded.oembed_status`,
        oembedCode: sql`excluded.oembed_code`,
        oembedCheckedAt: sql`excluded.oembed_checked_at`,
      },
    });
}

/**
 * The status of every video asked about, checking the ones nobody has a fresh
 * answer for first.
 *
 * Reads the view; checks the `unknown` ones over oEmbed in one bounded wave
 * (`VIDEO_CHECK_CONCURRENCY` at a time, each request bounded by
 * `VIDEO_CHECK_TIMEOUT_MS`); then reads the view again for those, so the
 * resolution rule lives in the view alone.
 *
 * **Fails open.** A check that gets no answer leaves its video `unknown`, and
 * the caller offers it: an unreachable YouTube must never empty the trainer.
 */
export async function ensureVideoStatus(
  videoIds: readonly string[],
): Promise<ReadonlyMap<string, VideoStatus>> {
  const ids = [...new Set(videoIds)];
  if (ids.length === 0) return new Map();

  const known = await readVideoStatus(ids);
  const unchecked = ids.filter((id) => known.get(id) === "unknown");
  if (unchecked.length === 0) return known;

  await Promise.all(
    unchecked.map((id) =>
      inflight.run(id, () => gate.run(() => checkAndRecord(id))),
    ),
  );
  for (const [id, status] of await readVideoStatus(unchecked)) {
    known.set(id, status);
  }
  return known;
}
