/**
 * The op-status banner and chip read what an op is WAITING on, live, off the op
 * log (plan: research/2026-09-29-global-unified-op-status.md, "Verification").
 *
 * A synthetic op (`../scripts/synthetic-op.ts`, a real process driving the real
 * writers) runs in THIS checkout's namespace on branch `e2e-synthetic`:
 *
 *  1. flocked marker + `requested` + `wait-start duress-valve`
 *     (reason "cluster-onset: loadRatio", cycle 2) → the banner reads
 *     "held: host under duress … requeue #2" and the conversation's sidebar chip
 *     is the hourglass;
 *  2. `wait-end` + `granted` → the banner reads "Build — Building", no hourglass;
 *  3. `completed` → the synthetic build leaves the banner, and its row is in the
 *     history (the op detail pane, `opsHistory`) as Success;
 *  4. kill variant: a second synthetic op is SIGKILLed while parked, with no
 *     terminal. Only main's reconciler appends the interrupted close, so this
 *     step asserts it (within ~35 s) only with `--main-reconciles` — i.e. once
 *     main runs the op-store code. Without the flag it says so and SKIPS the
 *     assertion, then closes the dead op itself through the helper's
 *     reconciler stand-in so no dead row lingers in the banner.
 *
 * The run itself is an `e2e` op in the same namespace, so the banner keeps
 * showing that one after step 3 — the check is that the synthetic BUILD is gone.
 *
 *   ./equin run plugins/conversations/plugins/conversation-view/plugins/op-status/e2e/op-status-waits.ts \
 *     --conv <a conversation whose worktree is this checkout> [--out /tmp/op-status] [--main-reconciles]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  arg,
  flag,
  pathUrl,
  report,
  requireArg,
  snap,
  targetNamespace,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  LIVE_TIMEOUT_MS,
  closeSynthetic,
  startSynthetic,
  waitBanner,
  type Synthetic,
} from "./synthetic";

const USAGE =
  "op-status-waits.ts --conv <conversationId> [--out <prefix>] [--main-reconciles]";
// A contended host: first paint has been seen past 60 s.
const NAV_TIMEOUT_MS = 180_000;
// The reconciler tick is 30 s; a SIGKILL leaves no filesystem event.
const RECONCILE_TIMEOUT_MS = 40_000;

const CHIP = '[data-ui-owner^="OpStatusChip@"]';
const HOURGLASS = 'use[href$="-hourglass-empty"]';
// The sidebar row of the conversation on screen.
const ACTIVE_ROW =
  'button[aria-current="true"]:has([data-ui-owner^="ConversationItem@"])';

async function detailText(page: Page, opId: string): Promise<string> {
  await page.goto(pathUrl(`/debug/profiling/op-profile/${opId}`), {
    timeout: NAV_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });
  const settled = await waitFor(
    () => page.locator("body").innerText(),
    (t) => t.includes("e2e-synthetic") || t.includes("Op not found"),
    { timeoutMs: LIVE_TIMEOUT_MS },
  );
  return settled.value;
}

await withBrowser(async (h) => {
  const r = report("op-status: waits in the banner and chip");
  const convId = requireArg("conv", USAGE);
  const out = arg("out") ?? "/tmp/op-status-waits";
  const mainReconciles = flag("main-reconciles");
  const slug = targetNamespace();
  const dir = mkdtempSync(join(tmpdir(), "op-status-e2e-"));
  // Every op started, so the cleanup closes each whatever became of it (a
  // crashed or killed helper leaves its op in flight; closing a closed op is a
  // no-op).
  const started: Synthetic[] = [];

  const { page } = await h.session({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  const openConversation = async () => {
    await page.goto(pathUrl(`/agents/c/${convId}`), {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await page.locator(ACTIVE_ROW).first().waitFor({ state: "visible" });
  };

  try {
    await openConversation();
    r.note(`namespace ${slug}, conversation ${convId}`);

    // ── 1. parked on the duress valve, requeue cycle 2 ───────────────────────
    const op = startSynthetic(dir, slug, "main");
    started.push(op);
    r.ok(
      "synthetic op published marker + requested + wait-start",
      await op.step(0),
    );
    r.note(`synthetic op ${op.opId}`);
    const held = await waitBanner(
      page,
      (t) => t.includes("host under duress") && t.includes("requeue #2"),
    );
    r.ok(
      "banner: held: host under duress … requeue #2",
      held.ok,
      `banner text: ${JSON.stringify(held.value)}`,
    );
    r.ok(
      "banner names the build and the trip reason",
      held.value.includes(
        "Build — held: host under duress (cluster-onset: loadRatio)",
      ),
      `banner text: ${JSON.stringify(held.value)}`,
    );
    const chipHourglass = await waitFor(
      () => page.locator(`${ACTIVE_ROW} ${CHIP} ${HOURGLASS}`).count(),
      (n) => n === 1,
      { timeoutMs: LIVE_TIMEOUT_MS },
    );
    r.ok(
      "sidebar chip of this conversation is the hourglass",
      chipHourglass.ok,
      `hourglass icons in the active row's chip: ${chipHourglass.value}`,
    );
    await snap(page, out, "1-waiting");

    // ── 2. granted: working ──────────────────────────────────────────────────
    op.advance(1);
    r.ok("synthetic op appended wait-end + granted", await op.step(1));
    const working = await waitBanner(page, (t) =>
      t.includes("Build — Building"),
    );
    r.ok(
      "banner: Build — Building",
      working.ok,
      `banner text: ${JSON.stringify(working.value)}`,
    );
    r.ok(
      "banner no longer says held",
      !working.value.includes("host under duress"),
      `banner text: ${JSON.stringify(working.value)}`,
    );
    const noHourglass = await waitFor(
      () => page.locator(`${ACTIVE_ROW} ${CHIP} ${HOURGLASS}`).count(),
      (n) => n === 0,
      { timeoutMs: LIVE_TIMEOUT_MS },
    );
    r.ok("chip: no hourglass while working", noHourglass.ok);
    await snap(page, out, "2-working");

    // ── 3. completed: gone from the banner, present in the history ───────────
    op.advance(2);
    r.ok("synthetic op appended completed and released", await op.step(2));
    await op.exited;
    const gone = await waitBanner(page, (t) => !t.includes("Build —"));
    r.ok(
      "banner: the synthetic build is gone",
      gone.ok,
      `banner text: ${JSON.stringify(gone.value)}`,
    );
    await snap(page, out, "3-completed");
    const detail = await detailText(page, op.opId);
    r.ok(
      "history: the op's row is there, closed as Success",
      detail.includes("e2e-synthetic") && detail.includes("Success"),
      `detail pane: ${JSON.stringify(detail.slice(0, 400))}`,
    );
    await snap(page, out, "3-history");

    // ── 4. kill variant: no terminal, the marker's lock dies with it ─────────
    await openConversation();
    const victim = startSynthetic(dir, slug, "kill");
    started.push(victim);
    r.ok("victim op parked", await victim.step(0));
    const victimHeld = await waitBanner(page, (t) =>
      t.includes("host under duress"),
    );
    r.ok("banner shows the victim parked", victimHeld.ok);
    victim.kill();
    await victim.exited;
    r.note(`victim ${victim.opId} SIGKILLed with no terminal`);
    if (mainReconciles) {
      const closed = await waitBanner(
        page,
        (t) => !t.includes("Build —"),
        RECONCILE_TIMEOUT_MS,
      );
      r.ok(
        "reconciler closed the killed op within ~35 s",
        closed.ok,
        `banner text after ${closed.waitedMs} ms: ${JSON.stringify(closed.value)}`,
      );
      const killed = await detailText(page, victim.opId);
      r.ok(
        "history: the killed op is interrupted",
        killed.includes("interrupted"),
        `detail pane: ${JSON.stringify(killed.slice(0, 400))}`,
      );
      await snap(page, out, "4-interrupted");
    } else {
      r.note(
        "SKIPPED the interrupted-close assertion: only MAIN's reconciler appends " +
          "it, and main does not run the op-store code until this lands " +
          "(re-run with --main-reconciles then). Closing the dead op through the " +
          "helper's reconciler stand-in instead, so no dead row lingers.",
      );
      await closeSynthetic(victim.opId);
      const closed = await waitBanner(page, (t) => !t.includes("Build —"));
      r.ok(
        "stand-in close reaches the banner",
        closed.ok,
        `banner text: ${JSON.stringify(closed.value)}`,
      );
      const killed = await detailText(page, victim.opId);
      r.ok(
        "history: the stand-in close is interrupted",
        killed.includes("interrupted"),
        `detail pane: ${JSON.stringify(killed.slice(0, 400))}`,
      );
      await snap(page, out, "4-interrupted");
    }
  } finally {
    // Never leave a synthetic op parked (or its row open) behind a failure.
    for (const s of started) {
      s.kill(); // a no-op on an exited helper
      await s.exited;
      await closeSynthetic(s.opId);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  await r.finish();
});
