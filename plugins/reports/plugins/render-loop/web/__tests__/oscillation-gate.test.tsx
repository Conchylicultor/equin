// Gate 4a judges oscillation per ELEMENT. Siblings share one culprit signature
// (a filmstrip's thumbnails: same plugin, source line, owner and path), so a
// strip of images each finishing its load once — `opacity-0` dropped from its
// class — repeats one value across many elements without any of them cycling.
// That must not file a render-loop report; one element flipping its class back
// and forth at the same rate still must.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { report } from "@plugins/reports/web";
import { installRenderLoopDetector } from "../internal/render-loop-detector";

vi.mock("@plugins/reports/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  report: vi.fn(async () => null),
}));

const reportMock = vi.mocked(report);
let now = 0;
let uninstall: (() => void) | null = null;

/** One frame: run `write`, let the observer read its records, move the clock. */
async function frame(write: () => void, ms: number): Promise<void> {
  write();
  await Promise.resolve();
  await Promise.resolve();
  now += ms;
}

/** Let the async fire path (attribution, fingerprint hash) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** A strip of `n` thumbnails under one owner, all sharing one signature. */
function strip(n: number): HTMLImageElement[] {
  const root = document.createElement("div");
  root.dataset.pluginId = "debug.browser-recordings";
  document.body.appendChild(root);
  return Array.from({ length: n }, () => {
    const span = document.createElement("span");
    span.dataset.source = "run-strip.tsx:33";
    const img = document.createElement("img");
    img.className = "block opacity-0";
    span.appendChild(img);
    root.appendChild(span);
    return img;
  });
}

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  uninstall = installRenderLoopDetector();
  // Past the idle gate before anything is written.
  now = 5000;
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = "";
  reportMock.mockClear();
  vi.restoreAllMocks();
});

describe("render-loop gate 4a (oscillating attribute)", () => {
  it("files nothing for many siblings each settling once on the same value", async () => {
    // 184 loads a second for 6 s, as in report-1794968124-h77hdp: 8 images
    // finish per 43 ms commit.
    const imgs = strip(1104);
    for (let i = 0; i < imgs.length; i += 8) {
      await frame(() => {
        for (const img of imgs.slice(i, i + 8)) img.className = "block";
      }, 43);
    }
    await settle();
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("still files one element flipping between two values", async () => {
    const [img] = strip(1);
    for (let i = 0; i < 6 * 60; i += 1) {
      await frame(() => {
        img!.className = i % 2 === 0 ? "block" : "block opacity-0";
      }, 1000 / 60);
    }
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock.mock.calls[0]![0].data).toMatchObject({
      mutationClass: "oscillating-attr",
      attrName: "class",
    });
  });

  it("still files siblings that each flip back and forth", async () => {
    const imgs = strip(8);
    for (let i = 0; i < 6 * 23; i += 1) {
      await frame(() => {
        for (const img of imgs)
          img.className = i % 2 === 0 ? "block" : "block opacity-0";
      }, 1000 / 23);
    }
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(1);
  });
});
