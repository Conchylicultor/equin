import { z } from "zod";
import { settingsKey } from "@plugins/infra/plugins/audio-analysis/core";
import { ensureBeatFeatures } from "@plugins/infra/plugins/audio-analysis/server";
import { isNonRetryableError } from "@plugins/infra/plugins/jobs/server";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { findSongVideos } from "@plugins/integrations/plugins/youtube/plugins/song-videos/server";
import {
  parseUgTab,
  type UgTab,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import {
  alignChords,
  WEAK_MATCH_THRESHOLD,
  type AlignmentCandidate,
  type AlignmentPhase,
} from "../../core";
import type { AlignmentRecord } from "../../core/internal/record";
import {
  retryScored,
  untryCandidates,
  walkCandidates,
  type AlignmentWork,
} from "./decide";
import { songUgAlignment } from "./tables";
import { readWork } from "./work";

// The alignment's transcript, at `logs/sonata-ug-alignment.jsonl` of the backend
// that supervises it (the child's own output, tailed).
const ugAlignmentLog = defineLogSink({
  id: "sonata-ug-alignment",
  description:
    "Sonata UG alignment: the video search and its candidates, the recording's beat analysis (download, installs, extractor) and the sheet-to-beats alignment, with its transpose and score.",
  consumer: {
    kind: "internal",
    note: "Detached sonata.ug-alignment.align child transcript (apps/sonata/sources/ultimate-guitar/alignment): one song's beat-features fetch and the aligner's result (transpose, score). Failures surface as the song's alignment row `failed` (served on the sonata-ug-alignment live collection, shown in the player's Recording section) and the job dead-letter.",
  },
});

const UgAlignInputSchema = z.object({ songId: z.string() });

type Log = (line: string) => void;

/**
 * Beat features of `videoId`, then the sheet aligned to them. `onPhase` is
 * handed each stage as it starts — the analysis's own (`waiting` → `fetching`
 * → `installing` → `analysing`, none on a cache hit), then `aligning` — and
 * awaited, so the row shows it before the work goes on.
 */
async function alignTo(
  tab: UgTab,
  hash: string,
  videoId: string,
  exec: ExecContext,
  log: Log,
  onPhase: (phase: AlignmentPhase) => Promise<void>,
): Promise<AlignmentRecord> {
  const features = await ensureBeatFeatures(videoId, exec, { log, onPhase });
  await onPhase("aligning");
  const started = Date.now();
  const record = alignChords(parseUgTab(tab), features, {
    capo: tab.capo,
    sheetHash: hash,
    settingsKey: settingsKey(features.source.settings),
  });
  log(
    `${videoId}: score ${record.score.toFixed(3)}, transpose ${record.transpose}, ${record.segments.length} segments, ${Date.now() - started} ms`,
  );
  return record;
}

/** The chosen video, aligned (the `align` arm). */
async function runAlign(
  songId: string,
  work: Extract<AlignmentWork, { kind: "align" }>,
  exec: ExecContext,
  log: Log,
): Promise<void> {
  const { tab, videoId, hash } = work;
  log(`${songId}: aligning to ${videoId} (${work.reason})`);
  // Every NOT NULL column, not `{ phase }` alone: an upsert is INSERT … ON
  // CONFLICT, and Postgres rejects the proposed row's missing NOT NULL
  // columns before the conflict turns it into an update.
  const running = async (phase: AlignmentPhase | null): Promise<void> => {
    await songUgAlignment.upsert(songId, {
      status: "running",
      phase,
      error: null,
      errorPermanent: false,
    });
  };
  // No phase until the first stage starts (a cached analysis goes straight to
  // `aligning`).
  await running(null);
  try {
    const record = await alignTo(tab, hash, videoId, exec, log, running);
    const status = record.score >= WEAK_MATCH_THRESHOLD ? "aligned" : "weak";
    log(`${songId}: ${status}`);
    // A new video set while this ran supersedes this result: leave its
    // `queued` row for the run `onEnded` starts.
    const current = await songUgAlignment.get(songId);
    if (current?.videoId !== videoId) {
      log(`${songId}: the video changed while aligning — result dropped`);
      return;
    }
    await songUgAlignment.upsert(songId, {
      status,
      phase: null,
      record,
      error: null,
      errorPermanent: false,
    });
  } catch (err) {
    await songUgAlignment.upsert(songId, {
      status: "failed",
      phase: null,
      error: err instanceof Error ? err.message : String(err),
      // Only a video that will never be served is permanent: `decideWork`
      // never retries a permanent failure, not even after a sheet edit, so a
      // sheet that does not parse must stay retryable for its fix to align.
      errorPermanent: isNonRetryableError(err),
    });
    throw err;
  }
}

/**
 * The resolver still owns the choice: nobody set a video while it ran, and
 * the user did not cancel it (a Cancel normally stops this process outright;
 * this catches one that landed before the child was signalled).
 */
async function stillResolving(songId: string): Promise<boolean> {
  const row = await songUgAlignment.get(songId);
  return (
    row?.pick === "auto" && row.videoId === null && row.status !== "cancelled"
  );
}

/**
 * Find candidate videos for the song (when it has none yet), then align the
 * best untried ones in turn until one reaches the threshold (the `resolve`
 * arm). It gives up the moment the user sets a video.
 */
async function runResolve(
  songId: string,
  work: Extract<AlignmentWork, { kind: "resolve" }>,
  stored: readonly AlignmentCandidate[],
  storedRecord: AlignmentRecord | null,
  exec: ExecContext,
  log: Log,
): Promise<void> {
  const { tab, hash } = work;
  log(`${songId}: choosing a video (${work.reason})`);
  let candidates = work.retry ? retryScored(stored) : [...stored];
  if (work.release) {
    // Give the earlier choice back first, so the walk (which stops the
    // moment a video is set) knows the resolver owns the choice again.
    const released = await songUgAlignment.update(songId, {
      videoId: null,
      candidates,
    });
    if (released === undefined) {
      throw new Error(`${songId}: no alignment row to release the video of`);
    }
  }
  const progress = async (phase: AlignmentPhase | null): Promise<void> => {
    await songUgAlignment.upsert(songId, {
      status: "resolving",
      phase,
      error: null,
      errorPermanent: false,
      candidates,
    });
  };
  await progress(work.search ? "searching" : null);
  try {
    if (work.search) {
      const query = { artist: tab.artistName, title: tab.songName };
      log(`${songId}: searching for "${query.artist} – ${query.title}"`);
      const found = await findSongVideos(query, exec, { log });
      candidates = found.candidates.map((c, rank) => ({
        videoId: c.videoId,
        title: c.title,
        channel: c.channel,
        rank,
        sources: [...new Set(c.sources.map((s) => s.source))],
        outcome: "untried" as const,
        score: null,
        error: null,
      }));
      found.candidates.forEach((c, rank) =>
        log(
          `  #${rank} ${c.videoId} ${c.match.toFixed(2)} "${c.title ?? "?"}" · ${c.channel ?? "?"} [${c.reasons.join(", ")}]`,
        ),
      );
      if (!(await stillResolving(songId))) {
        log(
          `${songId}: a video was set while searching — the search is dropped`,
        );
        return;
      }
      await progress(null);
    }

    const walk = await walkCandidates(candidates, {
      shouldContinue: () => stillResolving(songId),
      onProgress: async (next) => {
        // A candidate just became `trying`: no phase until its first stage.
        candidates = next;
        await progress(null);
      },
      tryOne: async (candidate) => {
        log(`${songId}: trying #${candidate.rank} ${candidate.videoId}`);
        try {
          return await alignTo(
            tab,
            hash,
            candidate.videoId,
            exec,
            log,
            progress,
          );
        } catch (err) {
          // Logged whatever it is; the walk decides whether it is the
          // candidate's failure (move on) or the run's (rethrown).
          log(
            `${candidate.videoId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
      },
    });
    if (walk.kind === "interrupted" || !(await stillResolving(songId))) {
      log(
        `${songId}: a video was set (or the user cancelled) while trying candidates — stopping`,
      );
      return;
    }
    candidates = walk.candidates;
    if (walk.kind === "accepted") {
      log(
        `${songId}: picked ${walk.record.videoId} (${walk.record.score.toFixed(3)})`,
      );
      await songUgAlignment.upsert(songId, {
        videoId: walk.record.videoId,
        status: "aligned",
        phase: null,
        record: walk.record,
        error: null,
        errorPermanent: false,
        candidates,
      });
      return;
    }
    // None reached the threshold: ask the user. The best weak record is kept
    // and played meanwhile (`appliedAlignment` applies it while no video is
    // chosen); one left from an earlier run stands when this run scored none.
    const keep =
      walk.bestWeak ??
      (storedRecord !== null && storedRecord.sheetHash === hash
        ? storedRecord
        : null);
    log(
      `${songId}: no candidate reached ${WEAK_MATCH_THRESHOLD} — needs a video`,
    );
    await songUgAlignment.upsert(songId, {
      status: "needs-video",
      phase: null,
      record: keep,
      error: null,
      errorPermanent: false,
      candidates,
    });
  } catch (err) {
    // A candidate cut off mid-try goes back to untried, so the retry tries it.
    candidates = untryCandidates(candidates);
    await songUgAlignment.upsert(songId, {
      status: "failed",
      phase: null,
      error: err instanceof Error ? err.message : String(err),
      // Nothing about finding a video is permanent: a search that failed
      // (every source down, a bot check) may work next time.
      errorPermanent: false,
      candidates,
    });
    throw err;
  }
}

/**
 * Align one UG song's sheet to its recording — choosing the recording first
 * when the resolver owns the choice — in a detached child (`run` body): beat
 * analysis downloads audio and runs a minute of Python, and the search runs
 * yt-dlp, which need an `ExecContext` and must not run on a backend's event
 * loop.
 *
 * `lock` = the song, so two runs for one song never overlap; an enqueue that
 * loses the claim to a running alignment returns, and `onEnded` re-checks the
 * rows once that run has closed (its lock released), enqueueing again when the
 * sheet or the video moved while it ran.
 */
export const ugAlignJob = defineSupervisedJob({
  name: "sonata.ug-alignment.align",
  description:
    "Chooses a YouTube recording for an Ultimate Guitar song (when none was set) and aligns its chord sheet to the recording's beats.",
  input: UgAlignInputSchema,
  channel: ugAlignmentLog,
  lock: (input) => input.songId,
  async run({ songId }, { log, exec }) {
    const work = await readWork(songId);
    switch (work.kind) {
      case "idle":
        log(`${songId}: nothing to do (${work.reason})`);
        return;
      case "align":
        return runAlign(songId, work, exec, log);
      case "resolve": {
        const row = await songUgAlignment.get(songId);
        if (row === undefined)
          throw new Error(`${songId}: the alignment row vanished`);
        return runResolve(songId, work, row.candidates, row.record, exec, log);
      }
    }
  },
  async onEnded(_runId, terminal, { input, cancelled }): Promise<void> {
    const row = await songUgAlignment.get(input.songId);
    if (cancelled) {
      // The user's Cancel (`cancelUgAlignment`) already wrote `cancelled`, but
      // the child may have written over it before the signal reached it (a
      // phase, a `trying` candidate, a `failed` from its catch). Write it
      // again, now that nothing else writes: no "interrupted" failure, no
      // re-enqueue. Only a `queued` row is left alone — a video set or a retry
      // asked for after the Cancel, whose enqueue lost the claim to this run.
      if (row === undefined) return;
      if (row.status === "queued") {
        await ugAlignJob.enqueue({ songId: input.songId });
        return;
      }
      await songUgAlignment.upsert(input.songId, {
        status: "cancelled",
        phase: null,
        error: null,
        errorPermanent: false,
        candidates: untryCandidates(row.candidates),
      });
      return;
    }
    if (terminal.exitCode !== 0) {
      // A body that threw recorded `failed` itself; one killed mid-run left
      // `running` or `resolving`, which would read as busy forever.
      if (row?.status === "running" || row?.status === "resolving") {
        await songUgAlignment.upsert(input.songId, {
          status: "failed",
          phase: null,
          error: `The alignment was interrupted (exit ${terminal.exitCode}).`,
          errorPermanent: false,
        });
      }
      return;
    }
    const work = await readWork(input.songId);
    if (work.kind !== "idle" && row?.status !== "failed") {
      await ugAlignJob.enqueue({ songId: input.songId });
    }
  },
});
