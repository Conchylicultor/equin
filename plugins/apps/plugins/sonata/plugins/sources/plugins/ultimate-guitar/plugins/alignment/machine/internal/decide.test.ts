import { describe, expect, test } from "bun:test";
import type { UgTab } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import {
  ALIGNER_VERSION,
  sheetHash,
  WEAK_MATCH_THRESHOLD,
  type AlignmentCandidate,
} from "../../core";
import type { AlignmentRecord } from "../../core/internal/record";
import { MAX_TRIES_PER_RUN, RANK_MARGIN } from "../../core/internal/accept";
import {
  decideWork,
  retryScored,
  untryCandidates,
  walkCandidates,
  type AlignmentState,
} from "./decide";
import {
  YouTubeAudioDownloadError,
  YouTubeAudioUnavailableError,
} from "@plugins/integrations/plugins/youtube/plugins/audio-fetch/server/testing";

const tab: UgTab = {
  tabId: "1",
  songName: "Wonderwall",
  artistName: "Oasis",
  type: "Chords",
  key: null,
  capo: 2,
  tuning: "E A D G B E",
  content: "[Verse]\n[ch]Em7[/ch] [ch]G[/ch]\nToday is gonna be",
  urlWeb: "https://tabs.ultimate-guitar.com/tab/1",
};
const HASH = sheetHash(tab.content);

function record(
  videoId: string,
  score: number,
  over: Partial<AlignmentRecord> = {},
): AlignmentRecord {
  return {
    alignerVersion: ALIGNER_VERSION,
    videoId,
    analysisVersion: 1,
    settingsKey: "final0-fastchroma",
    sheetHash: HASH,
    durationSec: 4,
    beats: [0, 1, 2, 3].map((t) => ({ t, downbeat: t === 0 })),
    transpose: 2,
    segments: [{ kind: "gap", startBeat: 0, endBeat: 4 }],
    barConfidence: [1],
    score,
    ...over,
  };
}

function candidate(
  videoId: string,
  rank: number,
  over: Partial<AlignmentCandidate> = {},
): AlignmentCandidate {
  return {
    videoId,
    title: null,
    channel: null,
    rank,
    sources: ["youtube-search"],
    outcome: "untried",
    score: null,
    error: null,
    ...over,
  };
}

function state(over: Partial<AlignmentState>): AlignmentState {
  return {
    videoId: null,
    status: "queued",
    errorPermanent: false,
    record: null,
    pick: "auto",
    candidates: [],
    ...over,
  };
}

const kind = (s: Partial<AlignmentState>) => decideWork(tab, state(s));

describe("decideWork — the resolver owns the choice", () => {
  test("a new song (queued, no candidates) searches", () => {
    expect(kind({})).toMatchObject({
      kind: "resolve",
      search: true,
      retry: false,
    });
  });

  test("queued with candidates goes on from the next untried one, without searching", () => {
    expect(
      kind({
        candidates: [
          candidate("AAAAAAAAAAA", 0, { outcome: "not-embeddable" }),
        ],
      }),
    ).toMatchObject({
      kind: "resolve",
      search: false,
    });
  });

  test("a run that died mid-resolve is resumed", () => {
    expect(
      kind({ status: "resolving", candidates: [candidate("AAAAAAAAAAA", 0)] }),
    ).toMatchObject({
      kind: "resolve",
      search: false,
    });
  });

  test("a failed search is retried, a permanent failure is not", () => {
    expect(kind({ status: "failed" }).kind).toBe("resolve");
    expect(kind({ status: "failed", errorPermanent: true }).kind).toBe("idle");
  });

  test("a cancelled walk stays put, even after a sheet edit", () => {
    const cancelled = {
      status: "cancelled" as const,
      candidates: [
        candidate("AAAAAAAAAAA", 0, { outcome: "weak", score: 0.3 }),
        candidate("BBBBBBBBBBB", 1),
      ],
    };
    expect(kind(cancelled)).toEqual({
      kind: "idle",
      reason: "cancelled by the user",
    });
    expect(
      kind({
        ...cancelled,
        record: record("AAAAAAAAAAA", 0.3, { sheetHash: "an older sheet" }),
      }).kind,
    ).toBe("idle");
    // A cancelled search (no candidates yet) is idle too.
    expect(kind({ status: "cancelled" }).kind).toBe("idle");
  });

  test("needs-video stays put while the sheet is the one it was tried against", () => {
    expect(
      kind({
        status: "needs-video",
        record: record("AAAAAAAAAAA", 0.3),
        candidates: [
          candidate("AAAAAAAAAAA", 0, { outcome: "weak", score: 0.3 }),
        ],
      }).kind,
    ).toBe("idle");
    // No candidate even scored: nothing to compare against, nothing to redo.
    expect(kind({ status: "needs-video", record: null }).kind).toBe("idle");
  });

  test("needs-video re-tries the same candidates after a sheet edit", () => {
    expect(
      kind({
        status: "needs-video",
        record: record("AAAAAAAAAAA", 0.3, { sheetHash: "an older sheet" }),
        candidates: [
          candidate("AAAAAAAAAAA", 0, { outcome: "weak", score: 0.3 }),
        ],
      }),
    ).toMatchObject({
      kind: "resolve",
      search: false,
      retry: true,
      reason: "the sheet changed",
    });
  });
});

describe("decideWork — a chosen video", () => {
  test("the user's pick sticks: a user row with no video does nothing", () => {
    expect(kind({ pick: "user" })).toEqual({
      kind: "idle",
      reason: "no video set",
    });
  });

  test("a user's video is aligned, never re-picked", () => {
    expect(kind({ pick: "user", videoId: "UUUUUUUUUUU" })).toMatchObject({
      kind: "align",
      videoId: "UUUUUUUUUUU",
    });
  });

  test("an auto pick that aligned is idle, and a sheet edit re-aligns that video (not a new pick)", () => {
    const aligned = {
      videoId: "AAAAAAAAAAA",
      status: "aligned" as const,
      record: record("AAAAAAAAAAA", 0.8),
    };
    expect(kind(aligned).kind).toBe("idle");
    expect(
      kind({
        ...aligned,
        record: record("AAAAAAAAAAA", 0.8, { sheetHash: "older" }),
      }),
    ).toMatchObject({
      kind: "align",
      videoId: "AAAAAAAAAAA",
      reason: "the sheet changed",
    });
  });

  test("a cancelled alignment of a chosen video stays put, even after a sheet edit or a new aligner", () => {
    for (const pick of ["user", "auto"] as const) {
      const row = {
        pick,
        videoId: "AAAAAAAAAAA",
        status: "cancelled" as const,
      };
      expect(kind(row)).toEqual({
        kind: "idle",
        reason: "cancelled by the user",
      });
      expect(
        kind({
          ...row,
          record: record("AAAAAAAAAAA", 0.9, { sheetHash: "an older sheet" }),
        }).kind,
      ).toBe("idle");
      expect(
        kind({
          ...row,
          record: record("AAAAAAAAAAA", 0.9, {
            alignerVersion: ALIGNER_VERSION - 1,
          }),
        }).kind,
      ).toBe("idle");
    }
  });

  test("a retried cancel (queued again) aligns the video, or resumes the walk", () => {
    expect(kind({ pick: "user", videoId: "AAAAAAAAAAA" })).toMatchObject({
      kind: "align",
      videoId: "AAAAAAAAAAA",
    });
    expect(
      kind({
        candidates: [
          candidate("AAAAAAAAAAA", 0, { outcome: "weak", score: 0.3 }),
          candidate("BBBBBBBBBBB", 1),
        ],
      }),
    ).toMatchObject({ kind: "resolve", search: false, retry: false });
  });

  test("a new video set over an old record aligns", () => {
    expect(
      kind({
        pick: "user",
        videoId: "UUUUUUUUUUU",
        status: "aligned",
        record: record("AAAAAAAAAAA", 0.8),
      }),
    ).toMatchObject({ kind: "align", reason: "the video changed" });
  });

  test("a stale aligner version re-aligns a user's video", () => {
    expect(
      kind({
        pick: "user",
        videoId: "AAAAAAAAAAA",
        status: "aligned",
        record: record("AAAAAAAAAAA", 0.8, {
          alignerVersion: ALIGNER_VERSION + 1,
        }),
      }),
    ).toMatchObject({ kind: "align", reason: "the aligner changed" });
  });

  test("a stale aligner version re-picks an auto video: released, the tried candidates scored again", () => {
    const tried = [
      candidate("AAAAAAAAAAA", 0, { outcome: "weak", score: 0.49 }),
      candidate("BBBBBBBBBBB", 1, { outcome: "aligned", score: 0.68 }),
    ];
    expect(
      kind({
        videoId: "BBBBBBBBBBB",
        status: "aligned",
        candidates: tried,
        record: record("BBBBBBBBBBB", 0.68, {
          alignerVersion: ALIGNER_VERSION - 1,
        }),
      }),
    ).toMatchObject({
      kind: "resolve",
      search: false,
      retry: true,
      release: true,
    });
  });
});

/** A fake run: each video's record, or the error trying it throws; every try recorded. */
function fakeRun(
  outcomes: Record<string, AlignmentRecord | Error>,
  opts: { stopAfter?: number } = {},
) {
  const tried: string[] = [];
  const progress: AlignmentCandidate[][] = [];
  let asked = 0;
  return {
    tried,
    progress,
    hooks: {
      tryOne: (c: AlignmentCandidate) => {
        tried.push(c.videoId);
        const outcome = outcomes[c.videoId];
        if (outcome === undefined)
          return Promise.reject(new Error(`no outcome for ${c.videoId}`));
        return outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve(outcome);
      },
      shouldContinue: () => {
        asked += 1;
        return Promise.resolve(
          opts.stopAfter === undefined || asked <= opts.stopAfter,
        );
      },
      onProgress: (cs: AlignmentCandidate[]) => {
        progress.push(cs);
        return Promise.resolve();
      },
    },
  };
}

const scored = (videoId: string, score: number): AlignmentRecord =>
  record(videoId, score);

describe("walkCandidates", () => {
  const four = ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD"].map(
    (id, rank) => candidate(id, rank),
  );

  test("tries in rank order and accepts the first at or above the threshold", async () => {
    const run = fakeRun({
      AAAAAAAAAAA: scored("AAAAAAAAAAA", 0.3),
      BBBBBBBBBBB: scored("BBBBBBBBBBB", WEAK_MATCH_THRESHOLD),
      CCCCCCCCCCC: scored("CCCCCCCCCCC", 0.9),
    });
    const result = await walkCandidates([...four].reverse(), run.hooks);
    expect(run.tried).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.record.videoId).toBe("BBBBBBBBBBB");
    expect(
      result.candidates.map((c) => [c.videoId, c.outcome, c.score]),
    ).toEqual([
      ["AAAAAAAAAAA", "weak", 0.3],
      ["BBBBBBBBBBB", "aligned", WEAK_MATCH_THRESHOLD],
      ["CCCCCCCCCCC", "untried", null],
      ["DDDDDDDDDDD", "untried", null],
    ]);
  });

  test("a higher-ranked near miss is preferred to a lower-ranked pass that only just beat it", async () => {
    const studio = WEAK_MATCH_THRESHOLD - 0.02;
    const live = WEAK_MATCH_THRESHOLD + RANK_MARGIN / 2;
    const run = fakeRun({
      AAAAAAAAAAA: scored("AAAAAAAAAAA", studio),
      BBBBBBBBBBB: scored("BBBBBBBBBBB", live),
    });
    const result = await walkCandidates(four, run.hooks);
    expect(run.tried).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.record.videoId).toBe("AAAAAAAAAAA");
    expect(
      result.candidates.slice(0, 2).map((c) => [c.videoId, c.outcome]),
    ).toEqual([
      ["AAAAAAAAAAA", "aligned"],
      ["BBBBBBBBBBB", "aligned"],
    ]);
  });

  test("a lower-ranked pass that clearly beats a near miss is accepted", async () => {
    const run = fakeRun({
      AAAAAAAAAAA: scored("AAAAAAAAAAA", WEAK_MATCH_THRESHOLD - 0.02),
      BBBBBBBBBBB: scored(
        "BBBBBBBBBBB",
        WEAK_MATCH_THRESHOLD - 0.02 + RANK_MARGIN + 0.05,
      ),
    });
    const result = await walkCandidates(four, run.hooks);
    expect(result.kind === "accepted" && result.record.videoId).toBe(
      "BBBBBBBBBBB",
    );
    if (result.kind !== "accepted") return;
    expect(result.candidates[0]!.outcome).toBe("weak");
  });

  test(`tries at most ${MAX_TRIES_PER_RUN}, then is exhausted with the best weak record`, async () => {
    const run = fakeRun({
      AAAAAAAAAAA: scored("AAAAAAAAAAA", 0.2),
      BBBBBBBBBBB: scored("BBBBBBBBBBB", 0.4),
      CCCCCCCCCCC: scored("CCCCCCCCCCC", 0.3),
      DDDDDDDDDDD: scored("DDDDDDDDDDD", 0.9),
    });
    const result = await walkCandidates(four, run.hooks);
    expect(run.tried).toHaveLength(MAX_TRIES_PER_RUN);
    expect(result).toMatchObject({ kind: "exhausted" });
    if (result.kind !== "exhausted") return;
    expect(result.bestWeak?.videoId).toBe("BBBBBBBBBBB");
    expect(result.candidates.at(-1)?.outcome).toBe("untried");
  });

  test("an unavailable video fails that candidate only, and the walk goes on", async () => {
    const run = fakeRun({
      AAAAAAAAAAA: new YouTubeAudioUnavailableError(
        "AAAAAAAAAAA",
        "Private video",
      ),
      BBBBBBBBBBB: scored("BBBBBBBBBBB", 0.8),
    });
    const result = await walkCandidates(four, run.hooks);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.candidates[0]).toMatchObject({
      outcome: "failed",
      score: null,
      error: "Private video",
    });
  });

  test("a download that fails (an HTTP 403) fails that candidate only, with its reason", async () => {
    const run = fakeRun({
      AAAAAAAAAAA: scored("AAAAAAAAAAA", 0.3),
      BBBBBBBBBBB: new YouTubeAudioDownloadError(
        "BBBBBBBBBBB",
        "unable to download video data: HTTP Error 403: Forbidden",
      ),
      CCCCCCCCCCC: scored("CCCCCCCCCCC", 0.7),
    });
    const result = await walkCandidates(four, run.hooks);
    expect(run.tried).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"]);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.record.videoId).toBe("CCCCCCCCCCC");
    expect(
      result.candidates.map((c) => [c.videoId, c.outcome, c.error]),
    ).toEqual([
      ["AAAAAAAAAAA", "weak", null],
      [
        "BBBBBBBBBBB",
        "failed",
        "unable to download video data: HTTP Error 403: Forbidden",
      ],
      ["CCCCCCCCCCC", "aligned", null],
      ["DDDDDDDDDDD", "untried", null],
    ]);
  });

  test("a failure that is not the candidate's (the machine's, a bug) fails the run", async () => {
    const run = fakeRun({
      AAAAAAAAAAA: scored("AAAAAAAAAAA", 0.3),
      BBBBBBBBBBB: new Error("audio-python failed to install"),
      CCCCCCCCCCC: scored("CCCCCCCCCCC", 0.7),
    });
    expect(walkCandidates(four, run.hooks)).rejects.toMatchObject({
      message: "audio-python failed to install",
    });
    expect(run.tried).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
  });

  test("goes on from the next untried: refused, failed and scored candidates are skipped", async () => {
    const start = [
      candidate("AAAAAAAAAAA", 0, { outcome: "not-embeddable" }),
      candidate("BBBBBBBBBBB", 1, { outcome: "weak", score: 0.3 }),
      candidate("CCCCCCCCCCC", 2, { outcome: "failed" }),
      candidate("DDDDDDDDDDD", 3),
    ];
    const run = fakeRun({ DDDDDDDDDDD: scored("DDDDDDDDDDD", 0.7) });
    const result = await walkCandidates(start, run.hooks);
    expect(run.tried).toEqual(["DDDDDDDDDDD"]);
    expect(result.kind).toBe("accepted");
  });

  test("a candidate left 'trying' by a run that died is tried again", async () => {
    const run = fakeRun({ AAAAAAAAAAA: scored("AAAAAAAAAAA", 0.7) });
    await walkCandidates(
      [candidate("AAAAAAAAAAA", 0, { outcome: "trying" })],
      run.hooks,
    );
    expect(run.tried).toEqual(["AAAAAAAAAAA"]);
  });

  test("nothing untried is exhausted at once, with no weak record", async () => {
    const run = fakeRun({});
    const result = await walkCandidates(
      [candidate("AAAAAAAAAAA", 0, { outcome: "not-embeddable" })],
      run.hooks,
    );
    expect(result).toEqual({
      kind: "exhausted",
      candidates: [candidate("AAAAAAAAAAA", 0, { outcome: "not-embeddable" })],
      bestWeak: null,
    });
    expect(run.tried).toEqual([]);
  });

  test("marks the candidate being tried before trying it", async () => {
    const run = fakeRun({ AAAAAAAAAAA: scored("AAAAAAAAAAA", 0.7) });
    await walkCandidates(four, run.hooks);
    expect(run.progress[0]?.[0]?.outcome).toBe("trying");
  });

  test("stops when the user picks a video meanwhile (the user's pick sticks)", async () => {
    const run = fakeRun(
      {
        AAAAAAAAAAA: scored("AAAAAAAAAAA", 0.2),
        BBBBBBBBBBB: scored("BBBBBBBBBBB", 0.9),
      },
      { stopAfter: 1 },
    );
    const result = await walkCandidates(four, run.hooks);
    expect(result).toEqual({ kind: "interrupted" });
    expect(run.tried).toEqual(["AAAAAAAAAAA"]);
  });

  test("a try that throws an untyped error propagates", () => {
    const run = fakeRun({});
    expect(walkCandidates(four, run.hooks)).rejects.toThrow("no outcome");
  });
});

describe("retryScored", () => {
  test("scored and in-flight candidates go back to untried; refusals and failures stay", () => {
    expect(
      retryScored([
        candidate("AAAAAAAAAAA", 0, { outcome: "weak", score: 0.3 }),
        candidate("BBBBBBBBBBB", 1, { outcome: "aligned", score: 0.7 }),
        candidate("CCCCCCCCCCC", 2, { outcome: "not-embeddable" }),
        candidate("DDDDDDDDDDD", 3, { outcome: "failed", error: "HTTP 403" }),
      ]).map((c) => [c.outcome, c.score]),
    ).toEqual([
      ["untried", null],
      ["untried", null],
      ["not-embeddable", null],
      ["failed", null],
    ]);
  });
});

describe("untryCandidates", () => {
  test("only a candidate cut off mid-try goes back to untried", () => {
    const tried = [
      candidate("AAAAAAAAAAA", 0, { outcome: "weak", score: 0.3 }),
      candidate("BBBBBBBBBBB", 1, { outcome: "trying" }),
      candidate("CCCCCCCCCCC", 2, { outcome: "failed", error: "gone" }),
      candidate("DDDDDDDDDDD", 3),
    ];
    expect(untryCandidates(tried).map((c) => c.outcome)).toEqual([
      "weak",
      "untried",
      "failed",
      "untried",
    ]);
  });
});
