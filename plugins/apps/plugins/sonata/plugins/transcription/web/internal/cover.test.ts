import { describe, expect, test } from "bun:test";
import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { TranscriptionStatus } from "../../core";
import { songTranscriptionShape } from "../../shared/shape";
import { transcriptionCover } from "./cover";

/** A song row carrying the transcription exposure's slice. */
function song(status: TranscriptionStatus | null, error: string | null = null) {
  return {
    id: "song-1",
    source: "musicxml",
    $columns: {
      [songTranscriptionShape.exposure.slice]: {
        status,
        conversationId: null,
        error,
      },
    },
  } as unknown as Song;
}

describe("transcriptionCover", () => {
  test("pending while the agent transcribes", () => {
    expect(transcriptionCover(song("transcribing"))).toEqual({
      kind: "pending",
      label: "Transcribing…",
    });
  });

  test("failed, with the run's error, when it failed", () => {
    expect(transcriptionCover(song("failed", "no score found"))).toEqual({
      kind: "failed",
      message: "no score found",
    });
  });

  test("a transcribed song and one nobody transcribed are not its to answer for", () => {
    expect(transcriptionCover(song("ready"))).toBeUndefined();
    expect(transcriptionCover(song(null))).toBeUndefined();
  });
});
