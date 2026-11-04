import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  LoadedSongProvider,
  useEditLoadedRaw,
  useLibrarySongLoad,
  useLoadDocument,
  useSourceEdit,
  type LibrarySongLoad,
  type SourceEdit,
} from "../loaded-song";
import type { SongIdentity } from "../identity";

afterEach(cleanup);

/**
 * A source's edit is read WITH the song it belongs to, so a persist observer
 * can only ever save a song's content under that song's id; a load is never
 * an edit, so there is no echo to skip.
 */

const A: SongIdentity = { kind: "library", songId: "A" };
const B: SongIdentity = { kind: "library", songId: "B" };

function renderStore() {
  const edits: SourceEdit[] = [];
  const loads: LibrarySongLoad[] = [];
  let load: ReturnType<typeof useLoadDocument> | null = null;
  let edit: ReturnType<typeof useEditLoadedRaw> | null = null;
  function Probe() {
    load = useLoadDocument();
    edit = useEditLoadedRaw();
    edits.push(useSourceEdit("grid"));
    loads.push(useLibrarySongLoad());
    return null;
  }
  render(
    <LoadedSongProvider>
      <Probe />
    </LoadedSongProvider>,
  );
  return {
    edits,
    loads,
    load: (identity: SongIdentity, rawById: Record<string, unknown>) =>
      act(() => load?.(identity, rawById)),
    edit: (sourceId: string, raw: unknown) => act(() => edit?.(sourceId, raw)),
  };
}

describe("useSourceEdit: an edit comes with its own song", () => {
  it("a load is unedited; an edit carries the loaded song's id and the raw as loaded", () => {
    const s = renderStore();
    s.load(A, { grid: "a0" });
    expect(s.edits.at(-1)).toEqual({ kind: "unedited" });

    s.edit("grid", "a1");
    expect(s.edits.at(-1)).toEqual({
      kind: "edited",
      songId: "A",
      load: 1,
      raw: "a1",
      asLoaded: "a0",
    });

    // Switching songs: B's loaded content is never reported, let alone under A.
    s.load(B, { grid: "b0" });
    expect(s.edits.at(-1)).toEqual({ kind: "unedited" });
    s.edit("grid", "b1");
    expect(s.edits.at(-1)).toMatchObject({ songId: "B", raw: "b1", load: 2 });
  });

  it("a reload of the same song resets its edit: the reloaded raw is not an edit", () => {
    const s = renderStore();
    s.load(A, { grid: "a0" });
    s.edit("grid", "a1");
    s.load(A, { grid: "a1" });
    expect(s.edits.at(-1)).toEqual({ kind: "unedited" });
  });

  it("another source's edit leaves it unedited", () => {
    const s = renderStore();
    s.load(A, { grid: "a0", other: 1 });
    s.edit("other", 2);
    expect(s.edits.at(-1)).toEqual({ kind: "unedited" });
  });

  it("a file document's edits are never reported (nothing of it is persisted)", () => {
    const s = renderStore();
    s.load({ kind: "file", key: "f" }, { grid: "f0" });
    s.edit("grid", "f1");
    expect(s.edits.at(-1)).toEqual({ kind: "unedited" });
    expect(s.loads.at(-1)).toEqual({ kind: "none" });
  });
});

describe("useLibrarySongLoad: the song with its load", () => {
  it("bumps the load on every load, a reload of the same song included", () => {
    const s = renderStore();
    expect(s.loads.at(-1)).toEqual({ kind: "none" });
    s.load(A, {});
    expect(s.loads.at(-1)).toEqual({ kind: "library", songId: "A", load: 1 });
    s.load(A, {});
    expect(s.loads.at(-1)).toEqual({ kind: "library", songId: "A", load: 2 });
    s.load(B, {});
    expect(s.loads.at(-1)).toEqual({ kind: "library", songId: "B", load: 3 });
  });
});
