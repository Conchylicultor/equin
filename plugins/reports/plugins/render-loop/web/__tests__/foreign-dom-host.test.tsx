// A foreign renderer's host (a Google map): the library rewrites its own DOM
// on every camera move — Google's controls and scale text, the pin canvas —
// which filed render-loop reports while an automated tab's camera kept moving
// (report-1795046561-h9bqs0 and its siblings, 73–145/s, all under
// map.google). Those nodes are not React's: skipped. A React-owned node inside
// the host re-rendering in a loop must still file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { report } from "@plugins/reports/web";
import { ANIMATION_HOST_ATTR } from "../../core";
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

/** A map host as `ForeignDomHost` renders it, with one node inside. */
function hostWith(reactOwned: boolean): HTMLElement {
  const root = document.createElement("div");
  root.dataset.pluginId = "map.google";
  const host = document.createElement("div");
  host.setAttribute(ANIMATION_HOST_ATTR, "");
  const node = document.createElement("span");
  node.dataset.source = "google-map-impl.tsx:161";
  // What React stamps on a node it rendered (the detector's ownership test).
  if (reactOwned) Object.assign(node, { __reactFiber$test: {} });
  host.appendChild(node);
  root.appendChild(host);
  document.body.appendChild(root);
  return node;
}

/** Six seconds of a style flipping at 74/s, as Google's scale text did. */
async function flipStyle(node: HTMLElement): Promise<void> {
  for (let i = 0; i < 6 * 74; i += 1) {
    await frame(() => {
      node.setAttribute("style", i % 2 === 0 ? "height: 14px;" : "");
    }, 1000 / 74);
  }
}

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
  reportMock.mockClear();
  vi.restoreAllMocks();
});

describe("render-loop: a foreign renderer's host", () => {
  it("files nothing for the library's own nodes rewritten every frame", async () => {
    await flipStyle(hostWith(false));
    await settle();
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("still files a React-owned node inside it re-rendering in a loop", async () => {
    await flipStyle(hostWith(true));
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock.mock.calls[0]![0].data).toMatchObject({
      mutationClass: "oscillating-attr",
      attrName: "style",
    });
  });
});
