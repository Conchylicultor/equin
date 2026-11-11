import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ATTACHING_STATE } from "./collab-session";
import { useHydrationState, useSaveState } from "./use-collab-block-doc";

type Hold = Parameters<typeof useSaveState>[1] &
  Parameters<typeof useHydrationState>[0];

// A hold with no session — what a static render (react-dom/server, never
// hydrated) sees: no effect runs there, so none is ever started. Starting one
// (`ensure`, from the subscription) must not happen in a server render.
function sessionlessHold(): Hold {
  const never = (): never => {
    throw new Error("a server render subscribed to the hold");
  };
  return {
    ensure: never,
    peek: () => null,
    restartSession: never,
    ensureReplica: never,
    armProjection: never,
    subscribeDocUpdates: never,
    isSynced: never,
    subscribeSync: never,
    hydrationState: () => ({ state: ATTACHING_STATE, everRendered: false }),
    subscribeHydration: never,
    verifyRendered: never,
  } as unknown as Hold;
}

describe("the collab block doc's stores under a server render", () => {
  it("reads the save state as it stands: nothing to save", () => {
    function Probe() {
      const { saveState } = useSaveState("block-1", sessionlessHold());
      return <i>{saveState.phase}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>idle</i>");
  });

  it("reads the hydration snapshot as it stands: attaching, never rendered", () => {
    function Probe() {
      const s = useHydrationState(sessionlessHold());
      return <i>{`${s.state.kind},${String(s.everRendered)}`}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>attaching,false</i>");
  });
});
