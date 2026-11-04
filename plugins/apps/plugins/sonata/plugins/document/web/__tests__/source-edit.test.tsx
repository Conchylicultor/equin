import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  LoadedSongProvider,
  useEditSourceRaw,
  useLoadedDocument,
  useLibrarySongLoad,
  useLoadDocument,
  useLoadedRaw,
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
  let edit: ReturnType<typeof useEditSourceRaw> | null = null;
  const writers: ReturnType<typeof useEditSourceRaw>[] = [];
  const raws: unknown[] = [];
  function Probe() {
    load = useLoadDocument();
    edit = useEditSourceRaw(useLoadedDocument()?.identity ?? null);
    writers.push(edit);
    raws.push(useLoadedRaw().grid);
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
    raws,
    /** The writer the latest render held — kept, it goes stale on a switch. */
    writer: () => {
      const held = writers.at(-1);
      if (held === undefined) throw new Error("no render yet");
      return (sourceId: string, update: (raw: unknown) => unknown) =>
        act(() => held(sourceId, update));
    },
    load: (identity: SongIdentity, rawById: Record<string, unknown>) =>
      act(() => load?.(identity, rawById)),
    edit: (sourceId: string, raw: unknown) =>
      act(() => edit?.(sourceId, () => raw)),
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

describe("useEditSourceRaw: a write is bound to the document it was derived from", () => {
  it("drops a write from a writer held for an earlier song", () => {
    const s = renderStore();
    s.load(A, { grid: "a0" });
    const staleA = s.writer();
    s.load(B, { grid: "b0" });
    staleA("grid", () => "a1");
    expect(s.raws.at(-1)).toBe("b0");
    expect(s.edits.at(-1)).toEqual({ kind: "unedited" });
  });

  it("keeps a write across a reload of the same song", () => {
    const s = renderStore();
    s.load(A, { grid: "a0" });
    const heldA = s.writer();
    s.load(A, { grid: "a0" });
    heldA("grid", () => "a1");
    expect(s.raws.at(-1)).toBe("a1");
  });

  it("applies the update to the current raw, not the one the writer was read with", () => {
    const s = renderStore();
    s.load(A, { grid: { tab: "t0", alignment: null } });
    const held = s.writer();
    s.edit("grid", { tab: "t1", alignment: null });
    held("grid", (raw) => ({ ...(raw as object), alignment: "x" }));
    expect(s.raws.at(-1)).toEqual({ tab: "t1", alignment: "x" });
  });

  it("an update returning the current raw changes nothing", () => {
    const s = renderStore();
    s.load(A, { grid: "a0" });
    const renders = s.raws.length;
    s.edit("grid", "a0");
    s.writer()("grid", (raw) => raw);
    expect(s.raws.length).toBe(renders);
  });

  it("throws with no document loaded", () => {
    const s = renderStore();
    expect(() => s.edit("grid", "x")).toThrow(/no song loaded/);
  });
});
