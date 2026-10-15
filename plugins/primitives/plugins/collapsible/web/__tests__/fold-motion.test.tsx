import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FoldMotion,
} from "../internal/collapsible";
import { useCollapsible } from "../internal/use-collapsible";

// jsdom has neither the Web Animations API nor layout: stand in for both, and
// hold animation frames so a test decides when the next one runs.
interface FakeAnimation {
  keyframes: Keyframe[];
  onfinish: (() => void) | null;
  cancel: () => void;
}
const setupAnimate = Element.prototype.animate;
let animations: FakeAnimation[] = [];
let frames: Map<number, FrameRequestCallback> = new Map();
let nextFrameId = 0;

beforeEach(() => {
  animations = [];
  frames = new Map();
  Element.prototype.animate = function (keyframes) {
    const anim: FakeAnimation = {
      keyframes: keyframes as Keyframe[],
      onfinish: null,
      cancel: () => {},
    };
    animations.push(anim);
    return anim as unknown as Animation;
  };
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.set(++nextFrameId, cb);
    return nextFrameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  // The box's settled size, measured with the tween's cap released.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return { height: this.style.maxHeight === "" ? 120 : 0 } as DOMRect;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Element.prototype.animate = setupAnimate;
});

function nextFrame() {
  const pending = [...frames.values()];
  frames = new Map();
  act(() => pending.forEach((cb) => cb(performance.now())));
}

function Harness({ defaultOpen }: { defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger>Queue</CollapsibleTrigger>
      <CollapsibleContent>rows</CollapsibleContent>
    </Collapsible>
  );
}

const region = () =>
  document.querySelector<HTMLElement>('[data-slot="collapsible-content"]');

describe("CollapsibleContent fold motion", () => {
  it("does not animate content that starts open", () => {
    render(<Harness defaultOpen />);
    expect(region()).not.toBeNull();
    expect(frames.size).toBe(0);
    expect(animations).toHaveLength(0);
  });

  it("pins an unfold at its first frame and starts the tween on the next frame", () => {
    render(<Harness defaultOpen={false} />);
    expect(region()).toBeNull();

    fireEvent.click(screen.getByText("Queue"));
    // The commit: content mounted, held at height 0, no tween yet — one
    // created here would be dated before a slow mount and elapse unseen.
    expect(region()!.style.maxHeight).toBe("0px");
    expect(region()!.style.opacity).toBe("0");
    expect(animations).toHaveLength(0);

    nextFrame();
    expect(animations).toHaveLength(1);
    expect(animations[0]!.keyframes).toEqual([
      { maxHeight: "0px", opacity: 0 },
      { maxHeight: "120px", opacity: 1 },
    ]);
    // The pin is released to the tween, and the box settles unclipped.
    expect(region()!.style.maxHeight).toBe("");
    act(() => animations[0]!.onfinish!());
    expect(region()!.style.overflow).toBe("");
  });

  it("folds away from the natural height and unmounts when the tween ends", () => {
    render(<Harness defaultOpen />);
    fireEvent.click(screen.getByText("Queue"));
    expect(region()!.style.maxHeight).toBe("120px");

    nextFrame();
    expect(animations[0]!.keyframes).toEqual([
      { maxHeight: "120px", opacity: 1 },
      { maxHeight: "0px", opacity: 0 },
    ]);
    expect(region()).not.toBeNull();
    act(() => animations[0]!.onfinish!());
    expect(region()).toBeNull();
  });

  it("reverses from the pinned frame when flipped before the tween starts", () => {
    render(<Harness defaultOpen={false} />);
    fireEvent.click(screen.getByText("Queue"));
    // Flipped back before any frame ran: the fold-away starts from the pinned
    // height 0, not from the full height.
    fireEvent.click(screen.getByText("Queue"));
    nextFrame();
    expect(animations).toHaveLength(1);
    expect(animations[0]!.keyframes[0]).toEqual({
      maxHeight: "0px",
      opacity: 0,
    });
  });

  it("folds useCollapsible's content bag, controlled by its trigger", () => {
    function Own() {
      const { triggerProps, contentProps } = useCollapsible();
      return (
        <>
          <button {...triggerProps}>Own</button>
          <FoldMotion {...contentProps}>body</FoldMotion>
        </>
      );
    }
    render(<Own />);
    fireEvent.click(screen.getByText("Own"));
    const content = screen.getByRole("region");
    expect(content.textContent).toBe("body");
    expect(screen.getByText("Own").getAttribute("aria-controls")).toBe(
      content.id,
    );
    nextFrame();
    expect(animations).toHaveLength(1);
  });
});
