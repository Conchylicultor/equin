import type { Page } from "playwright";
import {
  hexColor,
  trackPageNetwork,
  waitForScreenReady,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { EXPERIMENTAL_CLASS } from "@plugins/framework/plugins/cli/plugins/build/plugins/experimental-marks/core";
import type {
  HostCapturePairBody,
  HostCapturePairResult,
  HostCaptureShot,
} from "../shared/protocol";
import { getSession, inCall, withThrowawayPage } from "./host-session";
import { inDriveSlot } from "./host-drives";

/**
 * `capturePair` — the host half of a before / after capture
 * (`POST /capture-pair`, `shared/protocol.ts`): both URLs captured in the
 * conversation's own session (its agent-origin marks, its write tracking and
 * revert), each in a throwaway page at the same viewport and colour scheme,
 * one after the other under ONE drive slot (two headless pages loaded at once
 * would be two slots' worth of work in one).
 *
 * Each page is captured once it is ready by the harness's rule
 * (`waitForScreenReady`: painted, network idle, no `aria-busy` loader). A page
 * that never painted throws — a flat rectangle is not a "before" — and a page
 * still showing a loader at the deadline is captured anyway, the loader named
 * in its shot so the caller can say so.
 */
export async function capturePair(
  body: HostCapturePairBody,
): Promise<HostCapturePairResult> {
  const { conversationId } = body;
  return inCall(conversationId, async () => {
    const session = await getSession(conversationId, body.target);
    const { result, waitedMs } = await inDriveSlot(async () => {
      const before = await withThrowawayPage(session, (page) =>
        captureOne(page, body.urls[0], body),
      );
      const after = await withThrowawayPage(session, (page) =>
        captureOne(page, body.urls[1], body),
      );
      return [before, after] as const;
    });
    return { shots: [result[0], result[1]], slotWaitedMs: waitedMs };
  });
}

async function captureOne(
  page: Page,
  url: string,
  body: HostCapturePairBody,
): Promise<HostCaptureShot> {
  // Tracked before the first request, or the network-idle wait refuses it.
  trackPageNetwork(page);
  await page.setViewportSize(body.viewport);
  await page.emulateMedia({ colorScheme: body.colorScheme });
  await page.addInitScript(stripExperimentalMark, EXPERIMENTAL_CLASS);
  const res = await page.goto(url, { waitUntil: "domcontentloaded" });
  const ready = await waitForScreenReady(page);
  if (ready.kind === "blank") {
    throw new Error(
      `${url} never painted: still one flat colour (${hexColor(ready.color)}) after ${ready.waitedMs}ms — the app did not render, so there is nothing to capture.`,
    );
  }
  const png = await page.screenshot();
  return {
    png: png.toString("base64"),
    url: page.url(),
    httpStatus: res?.status() ?? null,
    paintedAfterMs: ready.paintedAfterMs,
    stillBusy: ready.stillBusy,
  };
}

/**
 * Runs in the captured page before any of its scripts: takes the agent-worktree
 * build's `experimental` class off <html> as soon as the build's head stamp
 * adds it, so the shot of a worktree build carries neither the red frame nor
 * the other experimental marks (the Wish banner) — a before / after pair
 * compares the app, and main's shot never has them. The capture's own page
 * only: no setting is written, the user's own tabs keep their marks.
 */
function stripExperimentalMark(className: string): void {
  const root = document.documentElement;
  const strip = (): void => {
    if (root.classList.contains(className)) root.classList.remove(className);
  };
  strip();
  new MutationObserver(strip).observe(root, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
