import type { UgTab } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import { isYouTubeAudioError } from "@plugins/integrations/plugins/youtube/plugins/audio-fetch/server";
import {
  ALIGNER_VERSION,
  sheetHash,
  WEAK_MATCH_THRESHOLD,
  type AlignmentCandidate,
  type UgAlignmentRow,
} from "../../core";
import type { AlignmentRecord } from "../../core/internal/record";
import {
  chooseCandidate,
  MAX_TRIES_PER_RUN,
  type TriedCandidate,
} from "../../core/internal/accept";

// ── What the job does, decided from the rows (pure) ──────────────────────────

/** What aligning one song would take right now, decided from its two rows. */
export type AlignmentWork =
  | { kind: "idle"; reason: string }
  /** Align the sheet to the chosen video. */
  | {
      kind: "align";
      reason: string;
      tab: UgTab;
      videoId: string;
      hash: string;
    }
  /**
   * Choose a video: search for candidates (`search`), or walk the stored ones
   * from the next untried. `retry` first puts the ones already scored back to
   * untried (the sheet or the aligner changed, so their scores are stale).
   * `release` first gives back the video the resolver chose earlier: the
   * aligner changed, so that choice was made on scores that no longer hold.
   */
  | {
      kind: "resolve";
      reason: string;
      tab: UgTab;
      hash: string;
      search: boolean;
      retry: boolean;
      release: boolean;
    };

export type AlignmentState = Pick<
  UgAlignmentRow,
  "videoId" | "status" | "errorPermanent" | "record" | "pick" | "candidates"
>;

/** The record no longer matches the sheet or the aligner. */
function stale(record: AlignmentRecord, hash: string): string | null {
  if (record.sheetHash !== hash) return "the sheet changed";
  if (record.alignerVersion !== ALIGNER_VERSION) return "the aligner changed";
  return null;
}

/**
 * The resolve arm: the resolver owns the choice (`pick: "auto"`) and has no
 * video yet.
 *
 * - `queued` (a new song, "Find a video", or a refused video): search when there
 *   are no candidates yet, else go on from the next untried one.
 * - `resolving` / `running`: a run that never finished — go on.
 * - `failed`: retry unless permanent.
 * - `cancelled`: nothing — the user stopped it; only their retry resumes it.
 * - `needs-video`: nothing to do — every candidate tried fell short — unless
 *   the sheet or the aligner changed since, when the same candidates are tried
 *   again (their scores were against another sheet).
 */
function decideResolve(tab: UgTab, row: AlignmentState): AlignmentWork {
  const hash = sheetHash(tab.content);
  const search = row.candidates.length === 0;
  const resolve = (reason: string, retry = false): AlignmentWork => ({
    kind: "resolve",
    reason,
    tab,
    hash,
    search,
    retry,
    release: false,
  });
  switch (row.status) {
    case "queued":
      return resolve(
        search ? "finding a video" : "trying the next candidate video",
      );
    case "resolving":
    case "running":
      return resolve("a previous run did not finish");
    case "failed":
      return row.errorPermanent
        ? { kind: "idle", reason: "failed permanently" }
        : resolve("retrying a failed video search");
    case "cancelled":
      return { kind: "idle", reason: "cancelled by the user" };
    case "needs-video": {
      const why = row.record === null ? null : stale(row.record, hash);
      return why === null
        ? { kind: "idle", reason: "no candidate video aligned well enough" }
        : resolve(why, true);
    }
    case "aligned":
    case "weak":
      // Only a video makes these: with none, the row is a resolve cut short.
      return resolve("no video chosen yet");
  }
}

/**
 * Whether a song's alignment is out of step with its sheet and video, and why.
 * Pure over the two rows, so the job body and its `onEnded` re-check decide
 * alike.
 *
 * - No video and `pick: "auto"`: the resolve arm (`decideResolve`).
 * - No video and `pick: "user"`: nothing to align to.
 * - `queued` (a new video or a re-align asked for) or `running` / `resolving`
 *   (left behind by a run that never finished): align.
 * - `failed`: align again unless the failure was permanent for this video.
 * - `cancelled`: nothing, whatever changed since (a sheet edit included) —
 *   the user stopped it, and only their retry or a new video restarts it.
 * - `aligned` / `weak` / `needs-video`: align only when the record no longer
 *   matches the current video, sheet or aligner. An edit re-aligns the chosen
 *   video, whoever chose it; it never re-picks one that aligned. A new aligner
 *   does re-pick a video the resolver chose (`pick: "auto"`): its choice was
 *   made on the old aligner's scores, so the candidates are scored again
 *   (their features are cached) and the accept rule runs anew.
 */
export function decideWork(tab: UgTab, row: AlignmentState): AlignmentWork {
  const videoId = row.videoId;
  if (videoId === null) {
    return row.pick === "auto"
      ? decideResolve(tab, row)
      : { kind: "idle", reason: "no video set" };
  }
  const hash = sheetHash(tab.content);
  const align = (reason: string): AlignmentWork => ({
    kind: "align",
    reason,
    tab,
    videoId,
    hash,
  });
  switch (row.status) {
    case "queued":
      return align("queued");
    case "running":
    case "resolving":
      return align("a previous run did not finish");
    case "failed":
      return row.errorPermanent
        ? { kind: "idle", reason: "failed permanently for this video" }
        : align("retrying a failed alignment");
    case "cancelled":
      return { kind: "idle", reason: "cancelled by the user" };
    case "aligned":
    case "weak":
    case "needs-video": {
      const r = row.record;
      if (r === null) return align("no record");
      if (r.videoId !== videoId) return align("the video changed");
      if (row.pick === "auto" && r.alignerVersion !== ALIGNER_VERSION)
        return {
          kind: "resolve",
          reason: "the aligner changed: choosing the video again",
          tab,
          hash,
          search: row.candidates.length === 0,
          retry: true,
          release: true,
        };
      const why = stale(r, hash);
      if (why !== null) return align(why);
      return {
        kind: "idle",
        reason: "already aligned to this sheet and video",
      };
    }
  }
}

// ── The candidate walk ───────────────────────────────────────────────────────

/**
 * Why trying one candidate failed, when the failure is the CANDIDATE's: its
 * audio could not be had — YouTube will not serve it, or its download failed
 * (an HTTP 403 on its stream) — so the walk marks it `failed` and moves on to
 * the next. Any other error — the machine's (a dependency that will not
 * install, no network, a bot check) or a bug (a DB write, a sheet that does not
 * parse) — is rethrown: it would fail every candidate alike, so it fails the
 * run, which stays retryable.
 */
export function candidateFailure(err: unknown): string {
  if (!isYouTubeAudioError(err)) throw err;
  return err.reason;
}

export type WalkResult =
  | {
      kind: "accepted";
      candidates: AlignmentCandidate[];
      record: AlignmentRecord;
    }
  | {
      kind: "exhausted";
      candidates: AlignmentCandidate[];
      /** The best weak record of this run (played while the user is asked); null when none scored. */
      bestWeak: AlignmentRecord | null;
    }
  /** `shouldContinue` said stop (the user picked a video meanwhile). */
  | { kind: "interrupted" };

/**
 * A candidate cut off mid-try (a run that failed, or one the user cancelled)
 * goes back to untried, so the next run tries it.
 */
export function untryCandidates(
  candidates: readonly AlignmentCandidate[],
): AlignmentCandidate[] {
  return candidates.map((c) =>
    c.outcome === "trying"
      ? { ...c, outcome: "untried", score: null, error: null }
      : c,
  );
}

/** Candidates scored against an earlier sheet go back to untried; refusals and failures stay. */
export function retryScored(
  candidates: readonly AlignmentCandidate[],
): AlignmentCandidate[] {
  return candidates.map((c) =>
    c.outcome === "aligned" || c.outcome === "weak" || c.outcome === "trying"
      ? { ...c, outcome: "untried", score: null, error: null }
      : c,
  );
}

/**
 * Try the untried candidates in rank order, at most `MAX_TRIES_PER_RUN`. After
 * each try `chooseCandidate` decides over this run's tries: once one reaches
 * `WEAK_MATCH_THRESHOLD`, the walk stops and accepts the highest-ranked try
 * within `RANK_MARGIN` of the best — so a studio recording that just missed is
 * not passed over for a live take that just passed. A try below the threshold
 * is `weak`, and the walk goes on. `tryOne` aligns one
 * candidate; a throw that is the candidate's own (`candidateFailure`: its
 * audio could not be had) marks it `failed` with the reason, and the walk goes
 * on. A `trying` left by a run that died is untried. Any other throw from
 * `tryOne` propagates (the job records it as a retryable failure).
 *
 * Before each try `shouldContinue` is asked (the resolver gives up the moment
 * the user picks a video), and `onProgress` is handed the candidates with the
 * one being tried marked `trying`.
 */
export async function walkCandidates(
  start: readonly AlignmentCandidate[],
  hooks: {
    tryOne: (candidate: AlignmentCandidate) => Promise<AlignmentRecord>;
    shouldContinue: () => Promise<boolean>;
    onProgress: (candidates: AlignmentCandidate[]) => Promise<void>;
  },
): Promise<WalkResult> {
  let candidates = [...start]
    .map((c) =>
      c.outcome === "trying" ? { ...c, outcome: "untried" as const } : c,
    )
    .sort((a, b) => a.rank - b.rank);
  const set = (videoId: string, patch: Partial<AlignmentCandidate>) => {
    candidates = candidates.map((c) =>
      c.videoId === videoId ? { ...c, ...patch } : c,
    );
  };
  const records = new Map<string, AlignmentRecord>();
  const tried: TriedCandidate[] = [];
  let tries = 0;
  for (const candidate of [...candidates]) {
    if (candidate.outcome !== "untried") continue;
    if (tries === MAX_TRIES_PER_RUN) break;
    if (!(await hooks.shouldContinue())) return { kind: "interrupted" };
    tries += 1;
    set(candidate.videoId, { outcome: "trying", score: null, error: null });
    await hooks.onProgress(candidates);
    let record: AlignmentRecord;
    try {
      record = await hooks.tryOne(candidate);
    } catch (err) {
      set(candidate.videoId, {
        outcome: "failed",
        score: null,
        error: candidateFailure(err),
      });
      continue;
    }
    set(candidate.videoId, {
      outcome: record.score >= WEAK_MATCH_THRESHOLD ? "aligned" : "weak",
      score: record.score,
    });
    records.set(candidate.videoId, record);
    tried.push({
      videoId: candidate.videoId,
      rank: candidate.rank,
      score: record.score,
    });
    const choice = chooseCandidate(tried, { exhausted: false });
    if (choice.kind === "accept") {
      // The one chosen became the video, whatever its own score.
      set(choice.videoId, { outcome: "aligned" });
      return {
        kind: "accepted",
        candidates,
        record: records.get(choice.videoId)!,
      };
    }
  }
  const end = chooseCandidate(tried, { exhausted: true });
  const best =
    end.kind === "exhausted" && end.best !== null
      ? records.get(end.best.videoId)!
      : null;
  return { kind: "exhausted", candidates, bestWeak: best };
}
