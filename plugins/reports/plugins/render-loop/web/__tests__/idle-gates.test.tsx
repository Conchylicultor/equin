// The idle gates judge the user idle through the WHOLE loop: no input for
// IDLE_MS before it is filed, a burst after a silent pause never inheriting the
// streak before it (each record is evaluated as it lands, so a burst's first
// one sees the window empty), and no input during the attribution window —
// input there makes the profiled commits the user's (the demo's Places named
// Map's camera re-render as a "loop" that way).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { report } from "@plugins/reports/web";
import {
  RENDER_PROFILER_GLOBAL,
  type RenderProfilerWindow,
} from "@plugins/debug/plugins/render-profiler/core";
import { installRenderLoopDetector } from "../internal/render-loop-detector";

vi.mock("@plugins/reports/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  report: vi.fn(async () => null),
}));

const reportMock = vi.mocked(report);
let now = 0;
let uninstall: (() => void) | null = null;

async function frame(write: () => void, ms: number): Promise<void> {
  write();
  await Promise.resolve();
  await Promise.resolve();
  now += ms;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** One element under a plugin marker, flipping its class every frame. */
function flipper(): (i: number) => void {
  const root = document.createElement("div");
  root.dataset.pluginId = "map.google";
  const span = document.createElement("span");
  span.dataset.source = "pin-canvas.tsx:1";
  root.appendChild(span);
  document.body.appendChild(root);
  return (i) => {
    span.className = i % 2 === 0 ? "a" : "b";
  };
}

const input = () =>
  window.dispatchEvent(new Event("pointermove", { bubbles: true }));

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  uninstall = installRenderLoopDetector();
  now = 5000;
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = "";
  delete (window as RenderProfilerWindow)[RENDER_PROFILER_GLOBAL];
  reportMock.mockClear();
  vi.restoreAllMocks();
});

describe("render-loop idle gates", () => {
  it("a burst after a silent pause does not inherit the streak before it", async () => {
    const flip = flipper();
    // The user drives writes for 2 s (a pan)…
    for (let i = 0; i < 120; i += 1) {
      await frame(() => {
        input();
        flip(i);
      }, 1000 / 60);
    }
    // …stops; nothing is written for 2.5 s…
    now += 2500;
    // …then a short burst with no input (the map's tiles landing).
    for (let i = 0; i < 40; i += 1) await frame(() => flip(i), 1000 / 60);
    await settle();
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("files nothing when the user acts during the attribution window", async () => {
    const flip = flipper();
    let i = 0;
    // The attribution window: input lands while React's commits are watched.
    (window as RenderProfilerWindow)[RENDER_PROFILER_GLOBAL] = {
      isRunning: () => false,
      start: () => {
        now += 500;
        input();
      },
      stop: () => {},
      getReport: () => ({ commitsPerSec: 0, initiators: [] }),
      componentsAbove: () => [],
    } as unknown as RenderProfilerWindow[typeof RENDER_PROFILER_GLOBAL];
    for (; i < 6 * 60; i += 1) await frame(() => flip(i), 1000 / 60);
    await new Promise((r) => setTimeout(r, 1600));
    await settle();
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("still files a loop the user stays idle through", async () => {
    const flip = flipper();
    (window as RenderProfilerWindow)[RENDER_PROFILER_GLOBAL] = {
      isRunning: () => false,
      start: () => {},
      stop: () => {},
      getReport: () => ({ commitsPerSec: 0, initiators: [] }),
      componentsAbove: () => [],
    } as unknown as RenderProfilerWindow[typeof RENDER_PROFILER_GLOBAL];
    for (let i = 0; i < 6 * 60; i += 1) await frame(() => flip(i), 1000 / 60);
    await new Promise((r) => setTimeout(r, 1600));
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(1);
  });
});
