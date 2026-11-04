import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  LoadedSongProvider,
  useEditLoadedRaw,
  useLoadDocument,
} from "../loaded-song";
import {
  usePersistSourceEdit,
  type EditedSource,
} from "../persist-source-edit";
import type { SongIdentity } from "../identity";

/**
 * A source's pending edit leaves only as a save: a newer edit of the same load
 * supersedes it, and anything else that ends it — another song, another load,
 * the observer unmounting — saves it at once under its own song.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const A: SongIdentity = { kind: "library", songId: "A" };
const B: SongIdentity = { kind: "library", songId: "B" };

function renderObserver() {
  const saves: { songId: string; raw: unknown }[] = [];
  let load: ReturnType<typeof useLoadDocument> | null = null;
  let edit: ReturnType<typeof useEditLoadedRaw> | null = null;
  function Store() {
    load = useLoadDocument();
    edit = useEditLoadedRaw();
    return null;
  }
  function Observer() {
    usePersistSourceEdit("grid", (e: EditedSource) =>
      saves.push({ songId: e.songId, raw: e.raw }),
    );
    return null;
  }
  function Tree({ observing }: { observing: boolean }) {
    return (
      <LoadedSongProvider>
        <Store />
        {observing && <Observer />}
      </LoadedSongProvider>
    );
  }
  const view = render(<Tree observing />);
  return {
    saves,
    load: (identity: SongIdentity, rawById: Record<string, unknown>) =>
      act(() => {
        load?.(identity, rawById);
      }),
    edit: (raw: unknown) =>
      act(() => {
        edit?.("grid", raw);
      }),
    wait: (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      }),
    unmountObserver: () => view.rerender(<Tree observing={false} />),
  };
}

describe("usePersistSourceEdit: a pending edit is saved, never dropped", () => {
  it("debounces a burst of edits into one save of the last", () => {
    const s = renderObserver();
    s.load(A, { grid: "a0" });
    s.edit("a1");
    s.wait(200);
    s.edit("a2");
    s.wait(499);
    expect(s.saves).toEqual([]);
    s.wait(1);
    expect(s.saves).toEqual([{ songId: "A", raw: "a2" }]);
  });

  it("loading another song within the debounce saves the edit under its own song", () => {
    const s = renderObserver();
    s.load(A, { grid: "a0" });
    s.edit("a1");
    s.load(B, { grid: "b0" });
    expect(s.saves).toEqual([{ songId: "A", raw: "a1" }]);
    s.wait(1000);
    expect(s.saves).toEqual([{ songId: "A", raw: "a1" }]);
  });

  it("an edit of the next song does not supersede the previous song's pending edit", () => {
    const s = renderObserver();
    s.load(A, { grid: "a0" });
    s.edit("a1");
    s.load(B, { grid: "b0" });
    s.edit("b1");
    s.wait(500);
    expect(s.saves).toEqual([
      { songId: "A", raw: "a1" },
      { songId: "B", raw: "b1" },
    ]);
  });

  it("a reload of the same song saves the edit pending from the load before", () => {
    const s = renderObserver();
    s.load(A, { grid: "a0" });
    s.edit("a1");
    s.load(A, { grid: "a0" });
    expect(s.saves).toEqual([{ songId: "A", raw: "a1" }]);
  });

  it("unmounting within the debounce saves the pending edit", () => {
    const s = renderObserver();
    s.load(A, { grid: "a0" });
    s.edit("a1");
    s.unmountObserver();
    expect(s.saves).toEqual([{ songId: "A", raw: "a1" }]);
    s.wait(1000);
    expect(s.saves).toHaveLength(1);
  });

  it("a load alone saves nothing", () => {
    const s = renderObserver();
    s.load(A, { grid: "a0" });
    s.load(B, { grid: "b0" });
    s.wait(1000);
    s.unmountObserver();
    expect(s.saves).toEqual([]);
  });
});
