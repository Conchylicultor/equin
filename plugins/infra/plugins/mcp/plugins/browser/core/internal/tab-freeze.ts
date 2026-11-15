// How the agent-browser host freezes and thaws an idle tab, as the CDP
// commands it sends — shared by the host (`bin/host-session.ts`) and the
// e2e flow proving a frozen tab is not reported as a frozen main thread
// (`reports/main-thread-stall/e2e/freeze.ts`), so the two cannot drift.

/** The CDP commands a freeze sends; Playwright's `CDPSession` is one. */
export interface TabFreezeCdp {
  send(
    method: "Runtime.evaluate",
    params: { expression: string },
  ): Promise<{
    exceptionDetails?: {
      text: string;
      exception?: { description?: string };
    };
  }>;
  send(
    method: "Debugger.enable" | "Debugger.pause" | "Debugger.disable",
  ): Promise<unknown>;
}

/**
 * Freeze: the page's JavaScript paused in the debugger (`Debugger.pause`), so
 * no rAF draws a frame. `Page.setWebLifecycleState: frozen` is not it —
 * headless pages are always visible, and Chromium ignores a freeze of a
 * visible page.
 *
 * So the freeze keeps the Page Lifecycle contract Chromium would have: the
 * document gets `freeze` first — its listeners run (the stall watchdog and
 * page-pauses hear of it) before the pause stops every script. Without it a
 * paused page reads as a frozen main thread: every idle tab became a
 * `main-thread-stall` report (a 35.8 s "rAF callback" with no JS sampled, a
 * 254.9 s freeze ended by the session's close, 2026-11-15) and every live
 * update it held a slow-op.
 */
export async function freezeTab(cdp: TabFreezeCdp): Promise<void> {
  await dispatchLifecycle(cdp, "freeze");
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.pause");
}

/**
 * Thaw: `Debugger.disable` resumes the page (or cancels a pause still pending
 * on a page that ran no JS since), then the document gets `resume` — its
 * listeners see the page running again.
 */
export async function thawTab(cdp: TabFreezeCdp): Promise<void> {
  await cdp.send("Debugger.disable");
  await dispatchLifecycle(cdp, "resume");
}

async function dispatchLifecycle(
  cdp: TabFreezeCdp,
  event: "freeze" | "resume",
): Promise<void> {
  const { exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression: `document.dispatchEvent(new Event(${JSON.stringify(event)}))`,
  });
  if (exceptionDetails)
    throw new Error(
      `dispatching "${event}" to a tab threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
    );
}
