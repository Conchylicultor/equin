/**
 * Several tabs share one demo: a tab joins the running demo, never takes it
 * from another tab (design: research/2026-11-11-framework-demo-tabs-join-never-take.md).
 * In `/demo`, in one fresh browser context, it:
 *
 *  1. boots the demo in a tab and creates a page, then opens THREE more tabs
 *     at once: each joins with no gate and lists the page;
 *  2. closes every tab, then opens two at the very same instant (the old
 *     worker retiring while both connect — the race that used to end one of
 *     them "opened in another tab"): both run the demo, on the same data;
 *  3. reloads one tab three times in a row while another stays open: it comes
 *     back each time, and a page created in the other tab shows in it, live;
 *  4. Reset demo in one tab and, at once, opens a new tab: every tab — the
 *     one that reset, the stale one that was open before, and the new one —
 *     comes back on the seed alone;
 *
 * and, throughout, no tab ever shows the stopped screen (`data-demo-stopped`:
 * watched for by a MutationObserver from before the page's first script, so
 * a screen shown for an instant is caught too), no page error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/multi-tab.ts [--out /tmp/demo-multi-tab] [--headed]
 */
import type { BrowserContext, Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  AGENT_MANAGER_LOCATION,
  bootDemo,
  createPage,
  demoPath,
  embedRoot,
  enterDemo,
  joinDemo,
  listed,
  MARKER,
  onDemoPage,
  openPages,
  RENDER_TIMEOUT_MS,
  ROOT_PAGES,
  settledCount,
  showsApp,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-multi-tab";
const URL = pathUrl(demoPath(AGENT_MANAGER_LOCATION));

/**
 * Before any script of every page of `context`: record each stopped screen
 * that ever appears (`[data-demo-stopped]`, its cause) in `window`.
 */
async function watchStoppedScreens(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __demoStopped: string[] }).__demoStopped = seen;
    const look = (): void => {
      for (const el of document.querySelectorAll("[data-demo-stopped]")) {
        const why = el.getAttribute("data-demo-stopped") ?? "?";
        if (!seen.includes(why)) seen.push(why);
      }
    };
    new MutationObserver(look).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-demo-stopped"],
    });
  });
}

/** The stopped screens `page` has shown since it loaded. */
function stoppedScreens(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __demoStopped?: string[] }).__demoStopped ?? [],
  );
}

/** No tab of `pages` ever showed a stopped screen. */
async function noneStopped(
  r: Report,
  name: string,
  pages: readonly Page[],
): Promise<void> {
  const shown = await Promise.all(pages.map((p) => stoppedScreens(p)));
  const any = shown.flat();
  r.ok(name, any.length === 0, any.length === 0 ? "none" : any.join(", "));
}

await withBrowser(async (h) => {
  const r = report("demo: several tabs share one demo, none takes it");
  const { page: first, context } = await h.session();
  await watchStoppedScreens(context);
  const stamp = Date.now().toString(36);
  const KEPT = `Many ${stamp}`;
  const LIVE = `Live ${stamp}`;

  // ── 1. three tabs opened at once join the running demo ─────────────────
  // Loaded again so the watcher (an init script) runs in it too.
  await bootDemo(first, URL, { marker: MARKER });
  await openPages(r, first, "first tab");
  const seeded = new Map<string, number>();
  for (const title of ROOT_PAGES) {
    seeded.set(
      title,
      await settledCount(r, first, `the seed lists "${title}"`, title),
    );
  }
  await createPage(first, KEPT);
  await listed(r, first, "the first tab lists its page", KEPT, "some");
  const many = await Promise.all([1, 2, 3].map(() => context.newPage()));
  await Promise.all(many.map((p) => p.goto(URL)));
  const joined = await Promise.all(
    many.map((p) => joinDemo(p, { marker: MARKER })),
  );
  r.ok(
    "three tabs opened at once each join the demo with no gate",
    joined.every(Boolean),
    joined.join(", "),
  );
  for (const [i, tab] of many.entries()) {
    await openPages(r, tab, `tab ${i + 2}`);
    await listed(
      r,
      tab,
      `tab ${i + 2} lists the first tab's page`,
      KEPT,
      "some",
    );
  }
  await noneStopped(r, "no tab showed a stopped screen (step 1)", [
    first,
    ...many,
  ]);
  await snap(many[2]!, OUT, "1-many");

  // ── 2. two tabs opened the instant the last one left ────────────────────
  await Promise.all([first, ...many].map((p) => p.close()));
  const pair = await Promise.all([context.newPage(), context.newPage()]);
  await Promise.all(pair.map((p) => p.goto(URL)));
  // No tab is in the demo when they load: each asks to enter — unless the
  // other entered first, then it joins.
  await Promise.all(pair.map((p) => enterOrJoin(p)));
  for (const [i, tab] of pair.entries()) {
    await openPages(r, tab, `racing tab ${i + 1}`);
    await listed(
      r,
      tab,
      `racing tab ${i + 1} runs the demo, on the kept data`,
      KEPT,
      "some",
    );
  }
  await noneStopped(r, "neither racing tab showed a stopped screen", pair);
  await snap(pair[1]!, OUT, "2-racing");

  // ── 3. reloads while another tab is open ────────────────────────────────
  const [stay, reloading] = pair as [Page, Page];
  for (let i = 1; i <= 3; i++) {
    await reloading.reload();
    // The other tab is in the demo: the reloaded one joins it, no gate.
    r.ok(
      `reload ${i}: the tab rejoins the demo with no gate`,
      await joinDemo(reloading, { marker: "[data-app-embed]" }),
    );
    await showsApp(
      r,
      reloading,
      `reload ${i}: the tab is back on Pages`,
      "pages",
    );
  }
  await createPage(stay, LIVE);
  await listed(
    r,
    reloading,
    "the reloaded tab lists the other tab's new page, live",
    LIVE,
    "some",
  );
  await noneStopped(r, "no tab showed a stopped screen (step 3)", [
    stay,
    reloading,
  ]);
  await snap(reloading, OUT, "3-reloaded");

  // ── 4. a new tab during Reset; the stale tab follows ────────────────────
  await stay.getByRole("button", { name: "Reset demo" }).first().click();
  await stay
    .getByRole("dialog")
    .getByRole("button", { name: "Reset demo" })
    .click();
  const during = await context.newPage();
  await during.goto(URL);
  r.ok(
    "a tab opened during the Reset joins the demo with no gate",
    await joinDemo(during, { marker: "[data-app-embed]" }),
  );
  for (const [tab, label] of [
    [stay, "the tab that reset"],
    [reloading, "the stale tab open before the Reset"],
    [during, "the tab opened during the Reset"],
  ] as const) {
    // Home is where a reset or fresh demo may land; Pages is one tile away.
    await embedOnPages(r, tab, label);
    for (const title of ROOT_PAGES) {
      await listed(
        r,
        tab,
        `${label} lists the seeded "${title}" as the first boot did`,
        title,
        seeded.get(title)!,
      );
    }
    await listed(r, tab, `${label} no longer lists "${KEPT}"`, KEPT, 0);
    await listed(r, tab, `${label} no longer lists "${LIVE}"`, LIVE, 0);
    r.ok(`${label} stays on the demo`, onDemoPage(tab.url()), tab.url());
  }
  await noneStopped(r, "no tab showed a stopped screen (step 4)", [
    stay,
    reloading,
    during,
  ]);
  await snap(during, OUT, "4-reset");
  await r.finish();
});

/** The demo page loaded with no other tab known to be in: Enter at its gate, or join the tab that entered first. */
async function enterOrJoin(tab: Page): Promise<void> {
  const gate = tab.locator('[data-demo-boot="gate"]').first();
  const shown = tab.locator(MARKER).first();
  await gate.or(shown).waitFor({ timeout: RENDER_TIMEOUT_MS });
  if (await gate.isVisible()) await enterDemo(tab, { marker: MARKER });
  else await shown.waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/** Bring `tab`'s demo to Pages: from Home's gallery (Pages is one of its tiles) when it landed there. */
async function embedOnPages(
  r: Report,
  tab: Page,
  label: string,
): Promise<void> {
  const app = await tab
    .locator("[data-app-embed]")
    .first()
    .getAttribute("data-app-embed", { timeout: RENDER_TIMEOUT_MS });
  if (app === "home") {
    await embedRoot(tab).getByText("Pages", { exact: true }).first().click();
  } else if (app !== "pages") {
    await openPages(r, tab, label);
  }
  await showsApp(r, tab, `${label} shows Pages`, "pages");
}
