/**
 * The picker's emit / commit contract, driven through the real component with
 * the Recent row's live read and its usage recorder stubbed: `onChange` per
 * move, `onCommit` only when a value settles (never mid-drag), suggestions not
 * recorded as recents, Reset disabled at the default, and the before swatch
 * reverting to the color the picker opened with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mounting live-state otherwise schedules real log flushes at module eval —
// the convention the live-state hazard suites established.
vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

const usage = vi.hoisted(() => ({
  recorded: [] as { namespace: string; key: string }[],
  recent: [] as string[],
}));

vi.mock("@plugins/primitives/plugins/usage-rank/web", () => ({
  useRecordUsage: () => (namespace: string, key: string) => {
    usage.recorded.push({ namespace, key });
  },
  useRecentUsage: () => ({
    status: "ready",
    data: usage.recent,
    refetch: () => Promise.resolve(),
  }),
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Color } from "../../core";
import { ColorPicker } from "../internal/color-picker";
import { SwatchGrid } from "../internal/swatch-grid";

const SUGGESTIONS = [
  { name: "violet", color: "#7c5cff" },
  { name: "azure", color: "#3b82f6" },
];

const BOX = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  width: 200,
  height: 100,
  right: 200,
  bottom: 100,
  toJSON: () => ({}),
};

// The two prototype members stubbed below, put back after each test.
const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);
const originalSetPointerCapture = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "setPointerCapture",
);

beforeEach(() => {
  usage.recorded = [];
  usage.recent = [];
  localStorage.clear();
  // jsdom implements neither a 2d canvas nor pointer capture.
  HTMLCanvasElement.prototype.getContext = (() => ({
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: () => {},
  })) as unknown as HTMLCanvasElement["getContext"];
  Element.prototype.setPointerCapture = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalGetContext) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalGetContext,
    );
  }
  if (originalSetPointerCapture) {
    Object.defineProperty(
      Element.prototype,
      "setPointerCapture",
      originalSetPointerCapture,
    );
  } else {
    delete (Element.prototype as Partial<Element>).setPointerCapture;
  }
});

function setup(props: Partial<React.ComponentProps<typeof ColorPicker>> = {}) {
  const onChange = vi.fn<(c: string) => void>();
  const onCommit = vi.fn<(c: string) => void>();
  render(
    <ColorPicker
      value="#7c5cff"
      onChange={onChange}
      onCommit={onCommit}
      swatches={SUGGESTIONS}
      title="Accent"
      defaultValue="#7c5cff"
      {...props}
    />,
  );
  return { onChange, onCommit };
}

function hexOf(oklch: string | undefined): string | undefined {
  return oklch == null ? undefined : Color.fromCss(oklch)?.toHex();
}

/** Pointer events as MouseEvents: jsdom has no PointerEvent, and React only reads the type. */
function pointer(el: Element, type: string, clientX: number, clientY: number) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
      }),
    );
  });
}

describe("ColorPicker", () => {
  it("a suggestion click emits, commits, and is not recorded as recent", () => {
    const { onChange, onCommit } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Azure" }));
    expect(hexOf(onChange.mock.lastCall?.[0])).toBe("#3b82f6");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(hexOf(onCommit.mock.lastCall?.[0])).toBe("#3b82f6");
    expect(usage.recorded).toEqual([]);
    expect(screen.getByText("Azure · suggested")).toBeTruthy();
  });

  it("typing a channel field emits as soon as the number parses, and commits on blur", () => {
    const { onChange, onCommit } = setup();
    const lightness = screen.getByRole("textbox", { name: "Lightness" });
    fireEvent.focus(lightness);
    fireEvent.change(lightness, { target: { value: "40" } });
    const emitted = Color.fromCss(onChange.mock.lastCall?.[0] ?? "");
    expect(emitted?.l).toBeCloseTo(0.4, 3);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(lightness);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(usage.recorded).toEqual([
      { namespace: "color-picker", key: emitted!.toHex() },
    ]);
  });

  it("a drag emits per move and commits once, on release", () => {
    const { onChange, onCommit } = setup();
    const area = screen.getByRole("slider", { name: "Lightness and chroma" });
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue(BOX as DOMRect);

    pointer(area, "pointerdown", 100, 50);
    pointer(area, "pointermove", 150, 20);
    pointer(area, "pointermove", 180, 10);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onCommit).not.toHaveBeenCalled();
    // Every point of the fitted area is displayable.
    for (const [css] of onChange.mock.calls) {
      expect(Color.fromCss(css)?.inGamut()).toBe(true);
    }

    pointer(area, "pointerup", 180, 10);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.lastCall?.[0]).toBe(onChange.mock.lastCall?.[0]);
    expect(usage.recorded).toHaveLength(1);
  });

  it("arrow keys on the hue slider emit, and commit on key-up", () => {
    const { onChange, onCommit } = setup();
    const hue = screen.getByRole("slider", { name: "Hue" });
    fireEvent.keyDown(hue, { key: "ArrowRight", shiftKey: true });
    const before = Color.fromHex("#7c5cff").h;
    expect(Color.fromCss(onChange.mock.lastCall?.[0] ?? "")?.h).toBeCloseTo(
      before + 10,
      0,
    );
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyUp(hue, { key: "ArrowRight" });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("Reset is disabled at the default and returns to it otherwise", () => {
    const { onChange, onCommit } = setup({ value: "#3b82f6" });
    const reset = screen.getByRole("button", { name: "Reset to default" });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reset);
    expect(hexOf(onChange.mock.lastCall?.[0])).toBe("#7c5cff");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByRole("button", {
          name: "Reset to default",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("the before swatch reverts to the color the picker opened with", () => {
    const { onChange, onCommit } = setup();
    const back = screen.getByRole("button", {
      name: "Back to the color you started with",
    });
    expect((back as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Azure" }));
    expect((back as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(back);
    expect(hexOf(onChange.mock.lastCall?.[0])).toBe("#7c5cff");
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("a recent color is picked, committed and re-recorded", () => {
    usage.recent = ["#e8553e"];
    const { onChange, onCommit } = setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Recent color #e8553e" }),
    );
    expect(hexOf(onChange.mock.lastCall?.[0])).toBe("#e8553e");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(usage.recorded).toEqual([
      { namespace: "color-picker", key: "#e8553e" },
    ]);
  });

  it("plain-string swatches emit the swatch's color", () => {
    const { onChange } = setup({
      swatches: ["#ff0000", "#00ff00"],
      title: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "#00ff00" }));
    expect(hexOf(onChange.mock.lastCall?.[0])).toBe("#00ff00");
  });
});

describe("SwatchGrid", () => {
  it("emits a plain swatch's exact string, painted through renderColor", () => {
    const onChange = vi.fn<(c: string) => void>();
    render(
      <SwatchGrid
        colors={["#FF0000", "#00ff00"]}
        value="#00ff00"
        renderColor={() => "black"}
        onChange={onChange}
      />,
    );
    const red = screen.getByRole("button", { name: "#FF0000" });
    expect(red.style.background).toBe("black");
    expect(red.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "#00ff00" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(red);
    expect(onChange).toHaveBeenCalledWith("#FF0000");
  });

  it("names a named suggestion under its dot", () => {
    const onChange = vi.fn<(c: string) => void>();
    render(<SwatchGrid colors={SUGGESTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Violet" }));
    expect(onChange).toHaveBeenCalledWith("#7c5cff");
  });
});
