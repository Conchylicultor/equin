import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { FloatingAction, FloatingActionFadeIn } from "../index";

/**
 * The content takes clicks only once it is revealed — open AND done morphing.
 * While the open morph runs, the items are still clipped at their collapsed
 * spot or sliding into place, so a click aimed at them would land on whatever
 * is under it.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** One open-morph transition the test settles by hand. */
function pendingMorph() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const finished = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // jsdom has no CSSTransition; the reveal waits on transitions only.
  class FakeTransition {
    finished = finished;
  }
  vi.stubGlobal("CSSTransition", FakeTransition);
  vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([
    new FakeTransition() as unknown as Animation,
  ]);
  return { resolve, reject };
}

function setup() {
  const utils = render(
    <FloatingAction label="Bar" trigger={<span>dot</span>}>
      <FloatingActionFadeIn>
        <button>item</button>
      </FloatingActionFadeIn>
    </FloatingAction>,
  );
  const wrapper = utils.getByLabelText("Bar");
  const inert = () => utils.getByText("item").closest("[inert]") !== null;
  return { wrapper, inert };
}

describe("FloatingAction reveal", () => {
  it("keeps the content inert until the open morph finishes", async () => {
    const morph = pendingMorph();
    const { wrapper, inert } = setup();
    fireEvent.pointerEnter(wrapper);
    expect(wrapper.hasAttribute("data-open")).toBe(true);
    expect(wrapper.hasAttribute("data-revealed")).toBe(false);
    expect(inert()).toBe(true);

    await act(async () => {
      morph.resolve();
      await Promise.resolve();
    });
    expect(wrapper.hasAttribute("data-revealed")).toBe(true);
    expect(inert()).toBe(false);
  });

  it("never reveals when a close cancels the morph", async () => {
    const morph = pendingMorph();
    const { wrapper, inert } = setup();
    fireEvent.pointerEnter(wrapper);
    fireEvent.keyDown(wrapper, { key: "Escape" });
    await act(async () => {
      morph.reject(new DOMException("cancelled", "AbortError"));
      await Promise.resolve();
    });
    expect(wrapper.hasAttribute("data-open")).toBe(false);
    expect(wrapper.hasAttribute("data-revealed")).toBe(false);
    expect(inert()).toBe(true);
  });

  it("reveals at once when nothing animates", async () => {
    const { wrapper, inert } = setup();
    await act(async () => {
      fireEvent.pointerEnter(wrapper);
      await Promise.resolve();
    });
    expect(wrapper.hasAttribute("data-revealed")).toBe(true);
    expect(inert()).toBe(false);
  });
});
