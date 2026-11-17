import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { usePublishOpenPopup } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import {
  holdReload,
  readReloadReadiness,
  resetReadinessStore,
} from "../internal/readiness-store";
import {
  installGestureWatcher,
  RECENT_INPUT_MS,
} from "../internal/gesture-watcher";
import { useReloadHold, useReloadReadiness } from "../internal/hooks";
import { reloadWhenReleased } from "../internal/quiet-reload";

let stop: (() => void) | null = null;
beforeEach(() => {
  resetReadinessStore();
  stop = installGestureWatcher(document);
});
afterEach(() => {
  cleanup();
  stop?.();
  stop = null;
  vi.useRealTimers();
  document.body.replaceChildren();
});

const labels = () => readReloadReadiness().holds.map((h) => h.label);

function pointer(type: string, init: PointerEventInit): void {
  document.body.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId: 1, ...init }),
  );
}

describe("holds", () => {
  it("lists a hold until it is released, and refuses a second release", () => {
    const release = holdReload("Upload");
    expect(labels()).toEqual(["Upload"]);
    release();
    expect(labels()).toEqual([]);
    expect(() => release()).toThrow(/released twice/);
  });

  it("useReloadHold holds while active and on unmount releases", () => {
    function Holder({ active }: { active: boolean }) {
      useReloadHold(active, { label: "Playback" });
      return null;
    }
    const view = render(<Holder active={false} />);
    expect(labels()).toEqual([]);
    view.rerender(<Holder active />);
    expect(labels()).toEqual(["Playback"]);
    view.unmount();
    expect(labels()).toEqual([]);
  });

  it("useReloadReadiness re-renders on a change", () => {
    const seen: number[] = [];
    function Probe() {
      seen.push(useReloadReadiness().holds.length);
      return null;
    }
    render(<Probe />);
    let release = (): void => {};
    act(() => {
      release = holdReload("Saving");
    });
    act(() => release());
    expect(seen.at(-1)).toBe(0);
    expect(seen).toContain(1);
  });
});

describe("engagement", () => {
  it("is engaged while a popup is open", () => {
    function Popup({ open }: { open: boolean }) {
      usePublishOpenPopup(open);
      return null;
    }
    const view = render(<Popup open />);
    expect(readReloadReadiness().engaged).toBe(true);
    view.rerender(<Popup open={false} />);
    expect(readReloadReadiness().engaged).toBe(false);
  });

  it("is engaged while focus is in a text field, not a button", () => {
    const input = document.createElement("input");
    const button = document.createElement("button");
    document.body.append(input, button);
    input.focus();
    expect(readReloadReadiness().engaged).toBe(true);
    button.focus();
    expect(readReloadReadiness().engaged).toBe(false);
  });

  it("stays engaged for 10 s after the last key", () => {
    vi.useFakeTimers();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true }),
    );
    expect(readReloadReadiness().engaged).toBe(true);
    vi.advanceTimersByTime(RECENT_INPUT_MS / 2);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true }),
    );
    vi.advanceTimersByTime(RECENT_INPUT_MS / 2 + 1);
    expect(readReloadReadiness().engaged).toBe(true);
    vi.advanceTimersByTime(RECENT_INPUT_MS / 2);
    expect(readReloadReadiness().engaged).toBe(false);
  });

  it("reads the page's visibility", () => {
    const spy = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(readReloadReadiness().hidden).toBe(true);
    spy.mockRestore();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(readReloadReadiness().hidden).toBe(false);
  });
});

describe("drag and playback holds", () => {
  it("a pressed pointer engages; moved past the threshold, it holds", () => {
    pointer("pointerdown", { clientX: 0, clientY: 0, buttons: 1 });
    expect(readReloadReadiness().engaged).toBe(true);
    expect(labels()).toEqual([]);
    pointer("pointermove", { clientX: 10, clientY: 0, buttons: 1 });
    expect(labels()).toEqual(["Drag"]);
    pointer("pointerup", { clientX: 10, clientY: 0, buttons: 0 });
    expect(labels()).toEqual([]);
  });

  it("a native drag holds until it ends, or until the next pointer event", () => {
    document.body.dispatchEvent(new Event("dragstart", { bubbles: true }));
    expect(labels()).toEqual(["Drag"]);
    document.body.dispatchEvent(new Event("dragend", { bubbles: true }));
    expect(labels()).toEqual([]);
    document.body.dispatchEvent(new Event("dragstart", { bubbles: true }));
    pointer("pointermove", { buttons: 0 });
    expect(labels()).toEqual([]);
  });

  it("a playing media element holds until it pauses, even detached", () => {
    const video = document.createElement("video");
    document.body.append(video);
    Object.defineProperty(video, "paused", {
      value: false,
      configurable: true,
    });
    video.dispatchEvent(new Event("play"));
    expect(labels()).toEqual(["Playback"]);
    video.remove();
    video.dispatchEvent(new Event("pause"));
    expect(labels()).toEqual([]);
  });
});

describe("quietReload", () => {
  it("reloads at once with no hold", async () => {
    const reload = vi.fn();
    void reloadWhenReleased(reload);
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("waits until every hold is released", async () => {
    const reload = vi.fn();
    const a = holdReload("Playback");
    const b = holdReload("Upload");
    void reloadWhenReleased(reload);
    await Promise.resolve();
    a();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
    b();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});
