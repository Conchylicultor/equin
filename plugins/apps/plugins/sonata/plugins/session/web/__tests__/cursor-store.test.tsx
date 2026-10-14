import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import {
  CursorStoreProvider,
  cursorApiFor,
  useCursorApi,
  useCursorSelector,
  type CursorApi,
} from "../cursor-store";
import { defineScopedStore } from "@plugins/primitives/plugins/scope/plugins/scoped-store/web";
import {
  songPosition,
  type PlayPosition,
} from "@plugins/apps/plugins/sonata/plugins/score/core";

afterEach(cleanup);

/**
 * The cursor store is now PER-SURFACE: state lives inside each
 * `<CursorStoreProvider>`. We assert (1) two providers hold independent cursors,
 * (2) the imperative facade's dedup/seek/meta plumbing, and (3) the reactive
 * hook (`useCursorSelector`) re-renders only when their slice
 * moves.
 */
describe("cursor-store", () => {
  it("two <CursorStoreProvider> mounts hold independent cursors", () => {
    const aRef = { current: null as CursorApi | null };
    const bRef = { current: null as CursorApi | null };

    function Grabber({ apiRef }: { apiRef: { current: CursorApi | null } }) {
      apiRef.current = useCursorApi();
      return null;
    }

    render(
      <>
        <CursorStoreProvider>
          <Grabber apiRef={aRef} />
        </CursorStoreProvider>
        <CursorStoreProvider>
          <Grabber apiRef={bRef} />
        </CursorStoreProvider>
      </>,
    );

    act(() => aRef.current!.setBeat(10, { seek: true }));
    expect(aRef.current!.getBeat()).toBe(10);
    // Mount B is untouched — fully isolated (the singleton-tear bug this fixes).
    expect(bRef.current!.getBeat()).toBe(0);
  });

  it("setBeat dedups an unchanged beat unless it's a seek, and forwards seek via meta", () => {
    // Drive the facade directly over a fresh scoped store, so we exercise the
    // dedup + seek-meta plumbing without React in the loop.
    const store = defineScopedStore<PlayPosition>(songPosition(0));
    let api: CursorApi | null = null;
    const seen: boolean[] = [];

    function Wire() {
      const s = store.useStoreApi();
      api = cursorApiFor(s);
      return null;
    }
    render(
      <store.Provider>
        <Wire />
      </store.Provider>,
    );

    const unsub = api!.subscribe((seek) => seen.push(seek));

    api!.setBeat(0); // same beat, not a seek → deduped (no notification)
    expect(seen).toEqual([]);
    expect(api!.getBeat()).toBe(0);

    api!.setBeat(1); // real advance → seek=false
    api!.setBeat(2); // real advance → seek=false
    expect(seen).toEqual([false, false]);

    api!.setBeat(2, { seek: true }); // same beat but a seek → still fires, seek=true
    expect(seen).toEqual([false, false, true]);
    expect(api!.getBeat()).toBe(2);

    unsub();
    api!.setBeat(3);
    expect(seen).toEqual([false, false, true]); // unsubscribed: no further notifications
  });

  it("useCursorSelector bails out off its slice", () => {
    let api: CursorApi | null = null;
    const selRenders = vi.fn();

    function SelectorReader() {
      selRenders();
      // Selects whether the cursor has passed beat 5 — stable across small moves.
      useCursorSelector((beat) => beat >= 5, []);
      return null;
    }
    function Grabber() {
      api = useCursorApi();
      return null;
    }

    render(
      <CursorStoreProvider>
        <Grabber />
        <SelectorReader />
      </CursorStoreProvider>,
    );

    expect(selRenders).toHaveBeenCalledTimes(1);

    // A small advance does NOT re-render the selector (still < 5).
    act(() => api!.setBeat(1));
    expect(selRenders).toHaveBeenCalledTimes(1);

    // Crossing the threshold flips the selected value → the selector re-renders.
    act(() => api!.setBeat(6));
    expect(selRenders).toHaveBeenCalledTimes(2);
  });
});
