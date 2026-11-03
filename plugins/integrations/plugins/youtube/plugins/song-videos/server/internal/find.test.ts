import { describe, expect, test } from "bun:test";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import type { OembedCheck } from "@plugins/integrations/plugins/youtube/server";
import { statusFromOembedCode } from "@plugins/integrations/plugins/youtube/core";
import type { SourceAnswer } from "../../core";
import { findSongVideosWith, SongVideoSourcesFailedError } from "./find";
import type { SongVideoSource } from "./source";

// The pipeline never touches `exec` itself; it only hands it to the sources.
const exec = {} as ExecContext;
const query = { artist: "Oasis", title: "Wonderwall" };

const source = (
  id: string,
  find: () => Promise<SourceAnswer>,
): SongVideoSource => ({
  id,
  find,
});

type OembedMeta = Extract<OembedCheck, { kind: "answered" }>["meta"];

const answered = (code: number, meta: OembedMeta = null): OembedCheck => ({
  kind: "answered",
  code,
  verdict: statusFromOembedCode(code),
  meta,
});

const ok = () => Promise.resolve(answered(200));

describe("findSongVideosWith", () => {
  test("merges the sources, ranks, and reports what each did", async () => {
    const result = await findSongVideosWith(
      {
        sources: [
          source("hooktheory", () =>
            Promise.resolve({
              kind: "unavailable",
              reason: "index not loaded",
            }),
          ),
          source("youtube-search", () =>
            Promise.resolve({
              kind: "answered",
              videos: [
                {
                  videoId: "AAAAAAAAAAA",
                  title: "Oasis - Wonderwall (Live)",
                  channel: "x",
                  durationSec: 250,
                  evidence: "search",
                },
                {
                  videoId: "BBBBBBBBBBB",
                  title: "Wonderwall",
                  channel: "Oasis - Topic",
                  durationSec: 259,
                  evidence: "search",
                },
              ],
            }),
          ),
        ],
        checkEmbed: ok,
      },
      query,
      exec,
    );
    expect(result.candidates.map((c) => c.videoId)).toEqual([
      "BBBBBBBBBBB",
      "AAAAAAAAAAA",
    ]);
    expect(result.sources).toEqual([
      { source: "hooktheory", kind: "unavailable", reason: "index not loaded" },
      { source: "youtube-search", kind: "answered", videos: 2 },
    ]);
    expect(result.refused).toEqual([]);
  });

  test("drops what oEmbed refuses, keeps what it could not answer, and names untitled videos", async () => {
    const checks: Record<string, OembedCheck> = {
      GONEGONEGON: answered(404),
      BLOCKEDBLOC: answered(401),
      NOANSWERNOA: { kind: "unreachable", reason: "timeout" },
      UNTITLEDUNT: answered(200, {
        kind: "read",
        title: "Oasis - Wonderwall",
        channel: "fan",
      }),
    };
    const result = await findSongVideosWith(
      {
        sources: [
          source("hooktheory", () =>
            Promise.resolve({
              kind: "answered",
              videos: Object.keys(checks).map((videoId) => ({
                videoId,
                title: null,
                channel: null,
                durationSec: null,
                evidence: "human-synced" as const,
              })),
            }),
          ),
        ],
        checkEmbed: (id) => Promise.resolve(checks[id]!),
      },
      query,
      exec,
    );
    expect(result.refused).toEqual([
      { videoId: "GONEGONEGON", status: "gone" },
      { videoId: "BLOCKEDBLOC", status: "not-embeddable" },
    ]);
    expect(new Set(result.candidates.map((c) => c.videoId))).toEqual(
      new Set(["NOANSWERNOA", "UNTITLEDUNT"]),
    );
    expect(
      result.candidates.find((c) => c.videoId === "UNTITLEDUNT"),
    ).toMatchObject({
      title: "Oasis - Wonderwall",
      channel: "fan",
    });
  });

  test("one failing source is reported; the others still count", async () => {
    const result = await findSongVideosWith(
      {
        sources: [
          source("broken", () => Promise.reject(new Error("bot check"))),
          source("youtube-search", () =>
            Promise.resolve({
              kind: "answered",
              videos: [
                {
                  videoId: "AAAAAAAAAAA",
                  title: "Oasis - Wonderwall",
                  channel: "x",
                  durationSec: null,
                  evidence: "search",
                },
              ],
            }),
          ),
        ],
        checkEmbed: ok,
      },
      query,
      exec,
    );
    expect(result.sources[0]).toEqual({
      source: "broken",
      kind: "failed",
      message: "bot check",
    });
    expect(result.candidates).toHaveLength(1);
  });

  test("every source failing throws", async () => {
    expect(
      findSongVideosWith(
        {
          sources: [source("broken", () => Promise.reject(new Error("down")))],
          checkEmbed: ok,
        },
        query,
        exec,
      ),
    ).rejects.toBeInstanceOf(SongVideoSourcesFailedError);
  });

  test("no source registered is a broken setup, not an empty answer", async () => {
    expect(
      findSongVideosWith({ sources: [], checkEmbed: ok }, query, exec),
    ).rejects.toThrow("No song-video source");
  });

  test("every source unavailable answers no candidates (not a failure)", async () => {
    const result = await findSongVideosWith(
      {
        sources: [
          source("hooktheory", () =>
            Promise.resolve({ kind: "unavailable", reason: "x" }),
          ),
        ],
        checkEmbed: ok,
      },
      query,
      exec,
    );
    expect(result.candidates).toEqual([]);
  });
});
