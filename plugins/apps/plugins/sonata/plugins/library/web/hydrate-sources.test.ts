import { describe, expect, test } from "bun:test";
import {
  ResourceError,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { combineHydrations, foldHydrations } from "./hydrate-sources";
import type { SourceHydration } from "./slots";

const Body = () => null;
const refetch = () => Promise.resolve();

function ready(data: SourceHydration): ResourceResult<SourceHydration> {
  return { status: "ready", data, refetch };
}

describe("foldHydrations", () => {
  test("folds raw, absent and pending", () => {
    const out = foldHydrations({
      a: { kind: "raw", raw: 1 },
      b: { kind: "absent" },
      c: { kind: "pending", label: "Transcribing", Body },
    });
    expect(out.rawMap).toEqual({ a: 1 });
    expect(out.pending).toEqual([
      { sourceId: "c", label: "Transcribing", Body },
    ]);
  });

  test("a raw of undefined is still a raw", () => {
    const out = foldHydrations({ a: { kind: "raw", raw: undefined } });
    expect("a" in out.rawMap).toBe(true);
  });
});

/** The song's owning source, read. */
function owns(source: string | null): ResourceResult<string | null> {
  return { status: "ready", data: source, refetch };
}

describe("combineHydrations", () => {
  test("ready once every source answered", () => {
    const out = combineHydrations(
      {
        a: ready({ kind: "raw", raw: 1 }),
        b: ready({ kind: "absent" }),
      },
      owns("a"),
    );
    expect(out).toMatchObject({
      status: "ready",
      data: { kind: "hydrated", rawMap: { a: 1 }, pending: [] },
    });
  });

  test("loading while one source has not answered", () => {
    const out = combineHydrations(
      {
        a: ready({ kind: "raw", raw: 1 }),
        b: { status: "loading", refetch },
      },
      owns("a"),
    );
    expect(out.status).toBe("loading");
  });

  test("a failed source fails the song, even while another loads", () => {
    const error = new ResourceError("loader-failed", "x", null);
    const out = combineHydrations(
      {
        a: { status: "loading", refetch },
        b: { status: "error", error, refetch },
      },
      owns("a"),
    );
    expect(out).toMatchObject({ status: "error", error: { message: "x" } });
  });

  test("no source is a song with nothing to load", () => {
    const out = combineHydrations({}, owns(null));
    expect(out.status).toBe("ready");
  });

  test("loading while the owning source's raw is not in yet", () => {
    // A transcription just marked ready (absent) while its MusicXML row is
    // still a moment behind (absent too): not a song with nothing to load.
    const out = combineHydrations(
      {
        musicxml: ready({ kind: "absent" }),
        transcription: ready({ kind: "absent" }),
      },
      owns("musicxml"),
    );
    expect(out).toMatchObject({
      status: "ready",
      data: { kind: "awaiting-owner", owner: "musicxml" },
    });
  });

  test("an owner no source answers for is not waited on", () => {
    const out = combineHydrations(
      { a: ready({ kind: "raw", raw: 1 }) },
      owns("not-installed"),
    );
    expect(out).toMatchObject({ status: "ready", data: { kind: "hydrated" } });
  });

  test("a pending source answers even before the owner's raw", () => {
    const out = combineHydrations(
      {
        musicxml: ready({ kind: "absent" }),
        transcription: ready({ kind: "pending", label: "Transcribing", Body }),
      },
      owns("musicxml"),
    );
    expect(out).toMatchObject({
      status: "ready",
      data: { kind: "hydrated", rawMap: {} },
    });
  });

  test("loading while the song row has not answered", () => {
    const out = combineHydrations(
      { a: ready({ kind: "raw", raw: 1 }) },
      { status: "loading", refetch },
    );
    expect(out.status).toBe("loading");
  });
});
