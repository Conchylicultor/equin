import type { LiveRowResult } from "@plugins/network/plugins/live/web";
import type { UgTab } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import {
  ALIGNER_VERSION,
  fitsSheet,
  MAX_TRIES_PER_RUN,
  type AlignmentCandidate,
  type AlignmentPhase,
  type UgAlignmentRow,
  type UgSourceRaw,
} from "../../core";

/** The three stages of getting a song onto a recording, in order. */
export type AlignStage = "find" | "analyse" | "align";
export const ALIGN_STAGES: readonly AlignStage[] = ["find", "analyse", "align"];

/**
 * What the job is doing right now: the row's live `phase`, or — between
 * phases — `queued` (no run has picked it up yet) and `preparing` (a run is on
 * it, its first stage not started).
 */
export type AlignStep = "queued" | "preparing" | AlignmentPhase;

/**
 * Where a working alignment stands. No percentage: nothing reports one, so the
 * stage is the honest granularity.
 */
export interface AlignProgress {
  stage: AlignStage;
  step: AlignStep;
  /**
   * The candidate the resolver is trying, while it walks them; `attempt` counts
   * this run's tries (at most `maxAttempts`).
   */
  candidate: { title: string; attempt: number; maxAttempts: number } | null;
}

/**
 * What the Recording section shows, derived from the live row and the open tab.
 * One arm per thing the user can be told; "not loaded yet" is its own arm, so a
 * pending read can never render as "no video".
 */
export type RecordingState =
  | { kind: "loading" }
  | { kind: "unreadable"; message: string }
  | { kind: "no-video" }
  /**
   * A job is on it: finding a video (`videoId` null, the resolver's walk), or
   * aligning the chosen one.
   */
  | { kind: "working"; videoId: string | null; progress: AlignProgress }
  /**
   * The resolver tried candidates and none aligned well enough: the user is
   * asked. `best` is the best try's score — that record still plays
   * (unconfirmed); null when none scored.
   */
  | { kind: "needs-video"; tried: number; best: number | null }
  | {
      kind: "aligned";
      videoId: string;
      score: number;
      /** Signed semitones, recording = sheet + transpose, in (−6, +6]. */
      transpose: number;
      capo: number;
      /** Made by an earlier aligner: still played, until the next re-align. */
      olderAligner: boolean;
    }
  /** Aligned below `WEAK_MATCH_THRESHOLD`: played all the same, as an unconfirmed match. */
  | { kind: "weak"; videoId: string; score: number; olderAligner: boolean }
  | {
      kind: "failed";
      videoId: string | null;
      message: string;
      permanent: boolean;
    }
  /** The user stopped it; nothing restarts it until they retry or set a video. */
  | { kind: "cancelled"; videoId: string | null }
  /**
   * The record cannot play this sheet — made for another sheet or video, or
   * its chords moved in today's parse — and nothing is re-aligning.
   */
  | { kind: "out-of-date"; videoId: string };

/** Candidates the resolver has tried (whatever came of them). */
export function triedCount(candidates: readonly AlignmentCandidate[]): number {
  return candidates.filter(
    (c) => c.outcome !== "untried" && c.outcome !== "trying",
  ).length;
}

/** The record's `[0, 12)` transpose as the nearer signed interval. */
export function signedTranspose(transpose: number): number {
  return transpose > 6 ? transpose - 12 : transpose;
}

/** A candidate's name: its title, or — a pasted video the resolver never listed — its id. */
export function candidateTitle(
  candidate: AlignmentCandidate | undefined,
  videoId: string,
): string {
  return candidate?.title ?? `YouTube video ${videoId}`;
}

const STAGE_OF_PHASE: Record<AlignmentPhase, AlignStage> = {
  searching: "find",
  waiting: "analyse",
  fetching: "analyse",
  installing: "analyse",
  analysing: "analyse",
  aligning: "align",
};

/**
 * Where a working row stands, or `null` when no job is on it (any status but
 * `queued`, `resolving` or `running`). Pure, from the row alone.
 *
 * Between phases the stage follows what is already settled: a video chosen
 * (the user's, or the resolver's accepted pick) or candidates found means the
 * find stage is done; with neither, finding has not finished.
 *
 * `attempt` is this run's try number. The row does not record a run's start,
 * so it is counted from the candidates the walk has tried, in runs of
 * `MAX_TRIES_PER_RUN` — exact unless an earlier run stopped early (a cancel or
 * a failure), and never above `maxAttempts`.
 */
export function alignProgress(row: UgAlignmentRow): AlignProgress | null {
  if (
    row.status !== "queued" &&
    row.status !== "resolving" &&
    row.status !== "running"
  ) {
    return null;
  }
  const trying = row.candidates.find((c) => c.outcome === "trying");
  const step: AlignStep =
    row.phase ?? (row.status === "queued" ? "queued" : "preparing");
  const stage: AlignStage =
    row.phase !== null
      ? STAGE_OF_PHASE[row.phase]
      : trying !== undefined ||
          row.videoId !== null ||
          row.candidates.length > 0
        ? "analyse"
        : "find";
  let candidate: AlignProgress["candidate"] = null;
  if (row.videoId === null && trying !== undefined) {
    const attempt = (triedCount(row.candidates) % MAX_TRIES_PER_RUN) + 1;
    const untried = row.candidates.filter(
      (c) => c.outcome === "untried",
    ).length;
    candidate = {
      title: candidateTitle(trying, trying.videoId),
      attempt,
      maxAttempts: Math.min(MAX_TRIES_PER_RUN, attempt + untried),
    };
  }
  return { stage, step, candidate };
}

/**
 * The video to play: the one the applied alignment is for (what the score
 * plays on — a weak match or the resolver's best try included), else the
 * row's chosen video, which plays unsynced until it has an alignment.
 */
export function recordingVideoId(
  raw: UgSourceRaw,
  result: LiveRowResult<UgAlignmentRow>,
): string | null {
  const found = result.status === "ready" && result.found ? result.row : null;
  return raw.alignment?.videoId ?? found?.videoId ?? null;
}

export function recordingState(
  result: LiveRowResult<UgAlignmentRow>,
  tab: UgTab,
): RecordingState {
  if (result.status === "loading") return { kind: "loading" };
  if (result.status === "error") {
    return { kind: "unreadable", message: result.error.message };
  }
  if (!result.found) return { kind: "no-video" };
  const row = result.row;
  const videoId = row.videoId;
  if (row.status === "failed") {
    return {
      kind: "failed",
      videoId,
      message: row.error ?? "The alignment failed.",
      permanent: row.errorPermanent,
    };
  }
  if (row.status === "cancelled") return { kind: "cancelled", videoId };
  // The user cleared their video: nothing runs until they set one.
  if (videoId === null && row.pick === "user") return { kind: "no-video" };
  const progress = alignProgress(row);
  if (progress !== null) return { kind: "working", videoId, progress };
  if (videoId === null) {
    if (row.status !== "needs-video") return { kind: "no-video" };
    const scores = row.candidates.flatMap((c) =>
      c.score === null ? [] : [c.score],
    );
    return {
      kind: "needs-video",
      tried: triedCount(row.candidates),
      best: scores.length === 0 ? null : Math.max(...scores),
    };
  }
  // aligned | weak | needs-video with a video: judged by its record — the same
  // rule as the player's (`appliedAlignment`): out of date exactly when the
  // record would not play.
  const record = row.record;
  if (
    record === null ||
    record.videoId !== videoId ||
    !fitsSheet(record, tab.content)
  ) {
    return { kind: "out-of-date", videoId };
  }
  const olderAligner = record.alignerVersion !== ALIGNER_VERSION;
  return row.status === "aligned"
    ? {
        kind: "aligned",
        videoId,
        score: record.score,
        transpose: signedTranspose(record.transpose),
        capo: tab.capo,
        olderAligner,
      }
    : { kind: "weak", videoId, score: record.score, olderAligner };
}

export const percent = (score: number) => `${Math.round(score * 100)}%`;

const olderAlignerNote = (older: boolean) =>
  older ? " · made by an earlier aligner (re-align to update)" : "";

/** "+2 (capo 2)", "−3", "0". */
export function formatTranspose(transpose: number, capo: number): string {
  const signed =
    transpose > 0 ? `+${transpose}` : transpose < 0 ? `−${-transpose}` : "0";
  return capo > 0 ? `${signed} (capo ${capo})` : signed;
}

const STEP_LABEL: Record<AlignStep, string> = {
  queued: "Waiting to start",
  preparing: "Preparing",
  searching: "Searching for a video",
  waiting: "Waiting for another analysis",
  fetching: "Downloading the audio",
  installing: "Installing the analyser",
  analysing: "Analysing the audio",
  aligning: "Aligning the sheet",
};

/**
 * The working step in words — "Analysing the audio…", or "Analysing the audio
 * (video 2 of 3)…" while the resolver walks its candidates.
 */
export function alignProgressLabel(progress: AlignProgress): string {
  const step = STEP_LABEL[progress.step];
  const c = progress.candidate;
  return c === null
    ? `${step}…`
    : `${step} (video ${c.attempt} of ${c.maxAttempts})…`;
}

/** The status line beside the icon (a failure's message goes on its own line, under it). */
export function recordingStateLine(state: RecordingState): string {
  switch (state.kind) {
    case "loading":
      return "Loading…";
    case "unreadable":
      return `Could not read the alignment: ${state.message}`;
    case "no-video":
      return "No recording";
    case "working":
      return alignProgressLabel(state.progress);
    case "needs-video":
      return state.best === null
        ? `No video aligned (${state.tried} tried)`
        : `Weak match (${percent(state.best)}) — timing unconfirmed`;
    case "aligned":
      return `Aligned ${percent(state.score)} · ${formatTranspose(state.transpose, state.capo)} semitones${olderAlignerNote(state.olderAligner)}`;
    case "weak":
      return `Weak match (${percent(state.score)}) — timing unconfirmed${olderAlignerNote(state.olderAligner)}`;
    case "failed":
      return "Alignment failed";
    case "cancelled":
      return "Alignment cancelled";
    case "out-of-date":
      return "Out of date — the alignment no longer fits this sheet; re-align to sync the video";
  }
}
