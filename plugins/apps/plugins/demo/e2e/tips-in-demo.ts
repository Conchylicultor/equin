/**
 * The first-time tips inside the demo: the app launcher's "Switch apps" and a
 * desktop window's "Leave the desktop", each shown once — and remembered inside
 * the demo (its worker's database), never in the page's.
 *
 * In `/demo` (a fresh context: the demo has met no tip), it:
 *
 *  1. enters the demo on the Agent Manager: the "Switch apps" tip shows,
 *     ringing the embed's launcher; Got it answers it — the card goes away and
 *     the demo's worker records the answer;
 *  2. picks Desktop from the launcher: the "Leave the desktop" tip shows on the
 *     focused window's Full screen control; Got it answers it, recorded too;
 *  3. reloads and enters again: neither tip shows again — the demo remembers
 *     them;
 *  4. throughout, no `/api/hints/…` request reached the page's server (the
 *     marks went to the demo's worker).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/tips-in-demo.ts [--out /tmp/demo-tips] [--headed]
 */
import type { Locator, Page } from "playwright";
import { pickFromLauncher } from "@plugins/apps-core/plugins/app-launcher/e2e";
import {
  hostRequestsAnswered,
  recordHostRequests,
} from "@plugins/framework/plugins/browser-server/e2e";
import { markHintSeenEndpoint } from "@plugins/hints/core";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  AGENT_MANAGER_LOCATION,
  ENTER_DEMO,
  MARKER,
  RENDER_TIMEOUT_MS,
  demoPath,
  embedRoot,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-tips";
/** Long enough for a tip's waiting window (2.5 s orientation + 1 s pause) and a seen read, with room. */
const NO_TIP_WAIT_MS = 6_000;

const SHOWN_TIP = '.hint-card[data-variant="tip"][data-on="true"]';
const SHOWN_HALO = '.hint-halo[data-on="true"]';

/** The shown tip card titled `title`. */
function tipCard(page: Page, title: string): Locator {
  return page.locator(SHOWN_TIP).filter({ hasText: title });
}

/** Enter the demo through its gate — no tip answered on the way: they are what this checks. */
async function enter(page: Page): Promise<void> {
  const gate = page.locator(ENTER_DEMO).first();
  await gate.waitFor({ timeout: RENDER_TIMEOUT_MS });
  await gate.click();
  await page.locator(MARKER).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/** Whether the centre of `inner` lies inside `outer`'s box. */
async function centredIn(inner: Locator, outer: Locator): Promise<boolean> {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (!a || !b) return false;
  const x = a.x + a.width / 2;
  const y = a.y + a.height / 2;
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

/**
 * Whether the shown halo comes to rest on `target` — waited for: a halo
 * moving from one tip to the next glides there (the stage's transition).
 */
async function ringed(page: Page, target: Locator): Promise<boolean> {
  const settled = await waitFor(
    () => centredIn(page.locator(SHOWN_HALO).first(), target),
    (on) => on,
    { timeoutMs: 5_000 },
  );
  return settled.ok;
}

await withBrowser(async (h) => {
  const r = report("demo: first-time tips");
  const { page } = await h.session();
  const hintCalls: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/hints"))
      hintCalls.push(`${req.method()} ${url.pathname}`);
  });

  // Before the page connects to the demo's worker: its answers are observed
  // as the port carries them.
  await recordHostRequests(page);
  /**
   * Press `card`'s Got it: the card goes away (at once — the session already
   * counts it answered) and the demo's worker answers the seen-mark. The card
   * is gone before the mark has even left the page, so a reload straight after
   * it can lose the mark; a visitor's answer is recorded by the worker.
   */
  const gotIt = async (card: Locator, tip: string): Promise<void> => {
    const marked = await hostRequestsAnswered(page, markHintSeenEndpoint, {});
    await card.getByRole("button").first().click();
    r.ok(
      `Got it puts ${tip} away`,
      (
        await waitFor(
          () => card.count(),
          (n) => n === 0,
          { timeoutMs: 5_000 },
        )
      ).ok,
    );
    const recorded = await waitFor(
      () => hostRequestsAnswered(page, markHintSeenEndpoint, {}),
      (n) => n > marked,
      { timeoutMs: 5_000 },
    );
    r.ok(
      `the demo's worker records ${tip} as seen`,
      recorded.ok,
      `${recorded.value - marked} answered (waited ${recorded.waitedMs} ms)`,
    );
  };

  await boot(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
    marker: ENTER_DEMO,
    timeoutMs: RENDER_TIMEOUT_MS,
  });
  await enter(page);

  // ── 1. Switch apps, on the embed's launcher ─────────────────────────────
  const switchApps = tipCard(page, "Switch apps");
  r.ok(
    "the Switch apps tip shows on entering an app",
    (
      await waitFor(
        () => switchApps.count(),
        (n) => n > 0,
        { timeoutMs: RENDER_TIMEOUT_MS },
      )
    ).ok,
  );
  r.ok(
    "its halo rings the embed's launcher",
    await ringed(
      page,
      embedRoot(page).getByRole("button", { name: "All apps" }).first(),
    ),
  );
  await snap(page, OUT, "1-switch-apps");
  await gotIt(switchApps, "Switch apps");

  // ── 2. Leave the desktop, on the focused window's Full screen ─────────────
  r.ok(
    "the launcher offers Desktop",
    await pickFromLauncher(embedRoot(page), /^\s*Desktop\s*$/),
  );
  const backToOne = tipCard(page, "Leave the desktop");
  r.ok(
    "the Leave the desktop tip shows when a window opens on the desktop",
    (
      await waitFor(
        () => backToOne.count(),
        (n) => n > 0,
        { timeoutMs: RENDER_TIMEOUT_MS },
      )
    ).ok,
  );
  r.ok(
    "its halo rings the window's Full screen control",
    await ringed(
      page,
      embedRoot(page).getByRole("button", { name: "Full screen" }).first(),
    ),
  );
  await snap(page, OUT, "2-back-to-one-app");
  await gotIt(backToOne, "Leave the desktop");

  // ── 3. Remembered inside the demo ───────────────────────────────────────
  await page.reload({ waitUntil: "domcontentloaded" });
  await enter(page);
  await page.waitForTimeout(NO_TIP_WAIT_MS);
  r.eq(
    "after a reload, no tip shows again",
    await page.locator(SHOWN_TIP).count(),
    0,
  );
  await snap(page, OUT, "3-after-reload");

  // ── 4. Sealed ───────────────────────────────────────────────────────────
  r.eq("no hints request reached the page's server", hintCalls, []);
  await r.finish();
});
