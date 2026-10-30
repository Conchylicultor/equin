import { describe, expect, it } from "bun:test";
import type { LiveRowResult } from "@plugins/network/plugins/live/web";
import type { UgTab } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import {
  ALIGNER_VERSION,
  sheetHash,
  type AlignmentCandidate,
  type UgAlignmentRow,
} from "../../core";
import type { AlignmentRecord } from "../../core/internal/record";
import {
  alignProgress,
  formatTranspose,
  recordingState,
  recordingStateLine,
} from "./recording-state";

const tab: UgTab = {
  tabId: "1",
  songName: "Song",
  artistName: "Artist",
  type: "Chords",
  key: null,
  capo: 2,
  tuning: "E A D G B E",
  content: "[Verse]\n[ch]G[/ch]\nla",
  urlWeb: "https://tabs.ultimate-guitar.com/tab/1",
};

const VIDEO = "dQw4w9WgXcQ";

function record(over: Partial<AlignmentRecord> = {}): AlignmentRecord {
  return {
    alignerVersion: ALIGNER_VERSION,
    videoId: VIDEO,
    analysisVersion: 1,
    settingsKey: "final0-fastchroma",
    sheetHash: sheetHash(tab.content),
    durationSec: 4,
    beats: [0, 1, 2, 3].map((t) => ({ t, downbeat: t === 0 })),
    transpose: 2,
    segments: [{ kind: "gap", startBeat: 0, endBeat: 4 }],
    barConfidence: [1],
    score: 0.82,
    ...over,
  };
}

const refetch = () => Promise.resolve();

function found(over: Partial<UgAlignmentRow>): LiveRowResult<UgAlignmentRow> {
  return {
    status: "ready",
    found: true,
    refetch,
    row: {
      songId: "s1",
      videoId: VIDEO,
      status: "queued",
      phase: null,
      error: null,
      errorPermanent: false,
      pick: "user",
      candidates: [],
      record: null,
      updatedAt: new Date(0),
      ...over,
    } as UgAlignmentRow,
  };
}

describe("recordingState", () => {
  it("is loading while the row is not known, never 'no video'", () => {
    expect(recordingState({ status: "loading", refetch }, tab).kind).toBe(
      "loading",
    );
  });

  it("is no-video for a song without a row", () => {
    expect(
      recordingState({ status: "ready", found: false, refetch }, tab).kind,
    ).toBe("no-video");
  });

  it("shows the aligned score and the signed transpose with the capo", () => {
    const state = recordingState(
      found({ status: "aligned", record: record() }),
      tab,
    );
    expect(state).toEqual({
      kind: "aligned",
      videoId: VIDEO,
      score: 0.82,
      transpose: 2,
      capo: 2,
      olderAligner: false,
    });
    expect(recordingStateLine(state)).toBe(
      "Aligned 82% · +2 (capo 2) semitones",
    );
  });

  it("reads a transpose above a tritone as the downward interval", () => {
    const state = recordingState(
      found({ status: "aligned", record: record({ transpose: 10 }) }),
      tab,
    );
    expect(state.kind === "aligned" && state.transpose).toBe(-2);
  });

  it("is out of date when the record was aligned to another sheet", () => {
    expect(
      recordingState(
        found({ status: "aligned", record: record({ sheetHash: "other" }) }),
        tab,
      ).kind,
    ).toBe("out-of-date");
  });

  it("still plays a record made by an earlier aligner, saying so", () => {
    const state = recordingState(
      found({
        status: "aligned",
        record: record({ alignerVersion: ALIGNER_VERSION - 1 }),
      }),
      tab,
    );
    expect(state.kind === "aligned" && state.olderAligner).toBe(true);
    expect(recordingStateLine(state)).toBe(
      "Aligned 82% · +2 (capo 2) semitones · made by an earlier aligner (re-align to update)",
    );
  });

  it("is out of date when the record's chords moved in today's parse", () => {
    expect(
      recordingState(
        found({
          status: "aligned",
          record: record({
            segments: [
              {
                kind: "chord",
                section: 0,
                line: 0,
                chord: 0,
                symbol: "Am",
                occurrence: 0,
                startBeat: 0,
                endBeat: 4,
              },
            ],
          }),
        }),
        tab,
      ).kind,
    ).toBe("out-of-date");
  });

  it("is a weak match below the threshold", () => {
    const state = recordingState(
      found({ status: "weak", record: record({ score: 0.31 }) }),
      tab,
    );
    expect(recordingStateLine(state)).toBe(
      "Weak match (31%) — timing unconfirmed",
    );
  });

  it("carries a failure's message and permanence", () => {
    expect(
      recordingState(
        found({ status: "failed", error: "gone", errorPermanent: true }),
        tab,
      ),
    ).toEqual({
      kind: "failed",
      videoId: VIDEO,
      message: "gone",
      permanent: true,
    });
  });

  it("shows the running phase as the align stage", () => {
    const state = recordingState(
      found({ status: "running", phase: "aligning" }),
      tab,
    );
    expect(state).toEqual({
      kind: "working",
      videoId: VIDEO,
      progress: { stage: "align", step: "aligning", candidate: null },
    });
    expect(recordingStateLine(state)).toBe("Aligning the sheet…");
  });

  it("a queued user video has found its video: it waits in the analyse stage", () => {
    const state = recordingState(found({ status: "queued" }), tab);
    expect(state).toEqual({
      kind: "working",
      videoId: VIDEO,
      progress: { stage: "analyse", step: "queued", candidate: null },
    });
    expect(recordingStateLine(state)).toBe("Waiting to start…");
  });

  it("is cancelled, with its video", () => {
    const state = recordingState(found({ status: "cancelled" }), tab);
    expect(state).toEqual({ kind: "cancelled", videoId: VIDEO });
    expect(recordingStateLine(state)).toBe("Alignment cancelled");
  });
});

function candidate(
  videoId: string,
  over: Partial<AlignmentCandidate> = {},
): AlignmentCandidate {
  return {
    videoId,
    title: null,
    channel: null,
    rank: 0,
    sources: ["youtube-search"],
    outcome: "untried",
    score: null,
    error: null,
    ...over,
  };
}

describe("recordingState — the resolver's choice", () => {
  const auto = { pick: "auto" as const, videoId: null };

  it("is finding a video while it searches", () => {
    const state = recordingState(found({ ...auto, status: "resolving" }), tab);
    expect(state).toEqual({
      kind: "working",
      videoId: null,
      progress: { stage: "find", step: "preparing", candidate: null },
    });
    expect(
      recordingStateLine(
        recordingState(
          found({ ...auto, status: "resolving", phase: "searching" }),
          tab,
        ),
      ),
    ).toBe("Searching for a video…");
  });

  it("a queued new song is finding a video too, never 'no recording'", () => {
    const state = recordingState(found({ ...auto, status: "queued" }), tab);
    expect(state).toMatchObject({
      kind: "working",
      progress: { stage: "find", step: "queued" },
    });
  });

  it("names the candidate it is trying", () => {
    const state = recordingState(
      found({
        ...auto,
        status: "resolving",
        phase: "aligning",
        candidates: [
          candidate("AAAAAAAAAAA", { outcome: "weak", score: 0.2 }),
          candidate("BBBBBBBBBBB", { outcome: "trying", title: "Wonderwall" }),
        ],
      }),
      tab,
    );
    expect(state).toEqual({
      kind: "working",
      videoId: null,
      progress: {
        stage: "align",
        step: "aligning",
        candidate: { title: "Wonderwall", attempt: 2, maxAttempts: 2 },
      },
    });
    expect(recordingStateLine(state)).toBe(
      "Aligning the sheet (video 2 of 2)…",
    );
  });

  it("needs a video once the candidates tried all fell short, with the count and best score", () => {
    const state = recordingState(
      found({
        ...auto,
        status: "needs-video",
        candidates: [
          candidate("AAAAAAAAAAA", { outcome: "weak", score: 0.31 }),
          candidate("BBBBBBBBBBB", { outcome: "failed" }),
          candidate("CCCCCCCCCCC", { outcome: "weak", score: 0.22 }),
          candidate("DDDDDDDDDDD"),
        ],
      }),
      tab,
    );
    expect(state).toEqual({ kind: "needs-video", tried: 3, best: 0.31 });
    expect(recordingStateLine(state)).toBe(
      "Weak match (31%) — timing unconfirmed",
    );
  });

  it("needs a video with nothing scored says so without a percentage", () => {
    expect(
      recordingStateLine(
        recordingState(found({ ...auto, status: "needs-video" }), tab),
      ),
    ).toBe("No video aligned (0 tried)");
  });

  it("an automatically picked video reads like any other once aligned", () => {
    expect(
      recordingState(
        found({ pick: "auto", status: "aligned", record: record() }),
        tab,
      ).kind,
    ).toBe("aligned");
  });

  it("a user row with no video is 'no recording'", () => {
    expect(recordingState(found({ videoId: null }), tab).kind).toBe("no-video");
  });
});

describe("alignProgress", () => {
  const row = (over: Partial<UgAlignmentRow>): UgAlignmentRow =>
    (found(over) as { row: UgAlignmentRow }).row;
  const auto = { pick: "auto" as const, videoId: null };

  it("is null when no job is on the row", () => {
    expect(alignProgress(row({ status: "aligned" }))).toBeNull();
    expect(alignProgress(row({ status: "cancelled" }))).toBeNull();
    expect(alignProgress(row({ status: "failed" }))).toBeNull();
  });

  it("maps the beat analysis's phases to the analyse stage", () => {
    for (const phase of [
      "waiting",
      "fetching",
      "installing",
      "analysing",
    ] as const) {
      expect(alignProgress(row({ status: "running", phase }))).toEqual({
        stage: "analyse",
        step: phase,
        candidate: null,
      });
    }
  });

  it("a candidate just marked trying, before its first phase, is preparing in the analyse stage", () => {
    expect(
      alignProgress(
        row({
          ...auto,
          status: "resolving",
          candidates: [candidate("AAAAAAAAAAA", { outcome: "trying" })],
        }),
      ),
    ).toEqual({
      stage: "analyse",
      step: "preparing",
      candidate: {
        title: "YouTube video AAAAAAAAAAA",
        attempt: 1,
        maxAttempts: 1,
      },
    });
  });

  it("a resumed walk (queued with candidates kept) is past finding", () => {
    expect(
      alignProgress(
        row({
          ...auto,
          status: "queued",
          candidates: [
            candidate("AAAAAAAAAAA", { outcome: "weak", score: 0.2 }),
            candidate("BBBBBBBBBBB"),
          ],
        }),
      ),
    ).toEqual({ stage: "analyse", step: "queued", candidate: null });
  });

  it("counts this run's tries, capped by what is left to try", () => {
    const progress = alignProgress(
      row({
        ...auto,
        status: "resolving",
        phase: "fetching",
        candidates: [
          candidate("AAAAAAAAAAA", { outcome: "weak", score: 0.2 }),
          candidate("BBBBBBBBBBB", { outcome: "trying", title: "Live" }),
          candidate("CCCCCCCCCCC"),
          candidate("DDDDDDDDDDD"),
        ],
      }),
    );
    expect(progress?.candidate).toEqual({
      title: "Live",
      attempt: 2,
      maxAttempts: 3,
    });
  });
});

describe("formatTranspose", () => {
  it("signs the interval and names the capo", () => {
    expect(formatTranspose(0, 0)).toBe("0");
    expect(formatTranspose(-3, 0)).toBe("−3");
    expect(formatTranspose(2, 2)).toBe("+2 (capo 2)");
  });
});
