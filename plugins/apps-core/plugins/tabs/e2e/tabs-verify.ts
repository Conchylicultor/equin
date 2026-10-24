// Walks the app-tab lifecycle (open, deepen, switch, reload, back/forward) and
// dumps the tab strip + URL at each step. A transcript tool, not a gate: it
// logs, it does not assert.
//
// Usage:
//   ./equin run plugins/apps-core/plugins/tabs/e2e/tabs-verify.ts [--url http://<worktree>.localhost:9000]

import {
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/tabs";

/** One tab-strip button as read out of the DOM. */
interface TabLabel {
  app: string | null;
  active: string | null;
}

await withBrowser(async (h) => {
  const { page, captured } = await h.session({ colorScheme: "dark" });

  const tabs = () => page.locator("button[data-app-tab]");
  async function dump(tag: string): Promise<TabLabel[]> {
    const labels: TabLabel[] = await tabs().evaluateAll((els) =>
      els.map((e) => ({
        app: e.getAttribute("data-app-tab"),
        active: e.getAttribute("aria-pressed"),
      })),
    );
    console.log(
      `[${tag}] url=${page.url()} tabs=${labels.length} ${JSON.stringify(labels)}`,
    );
    return labels;
  }

  await page.goto(pathUrl("/"));
  await page.waitForTimeout(3000);
  await dump("1-initial"); // expect 1 tab (home) from URL
  await snap(page, OUT, "1-initial");

  // 2) Click + → new Home tab appears and focuses.
  await page.getByRole("button", { name: "New tab" }).click();
  await page.waitForTimeout(900);
  await dump("2-after-+"); // expect 2 home tabs, 2nd active

  // 3) Open Studio from the Home launcher (tab-aware) → a Studio tab.
  await page.getByRole("button", { name: "Studio" }).first().click();
  await page.waitForTimeout(1200);
  await dump("3-open-studio"); // expect home,home,studio (studio active)
  await snap(page, OUT, "3-studio");

  // Deepen the Studio tab's route within the app: open the Explorer pane.
  await page.getByText("Explorer", { exact: true }).first().click();
  await page.waitForTimeout(1000);
  const tabAUrl = page.url(); // .../studio/explorer
  console.log("TAB A (studio) deep URL:", tabAUrl);
  await snap(page, OUT, "4-studio-deep");

  // 4) Switch to the first Home tab, then back to Studio.
  await tabs().nth(0).click();
  await page.waitForTimeout(900);
  await dump("4a-on-home");
  console.log("URL while on Home tab:", page.url());
  await snap(page, OUT, "5-home-tab");

  await tabs().nth(2).click(); // back to Studio tab
  await page.waitForTimeout(900);
  const backUrl = page.url();
  await dump("4b-back-to-studio");
  console.log("URL back on Studio tab:", backUrl);
  console.log("KEEP-ALIVE: studio deep route preserved:", backUrl === tabAUrl);
  await snap(page, OUT, "6-back-to-studio");

  // 5) Reload — tabs + routes restore from sessionStorage.
  const before: (string | null)[] = await tabs().evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-app-tab")),
  );
  await page.reload();
  await page.waitForTimeout(3000);
  const after = await dump("5-after-reload");
  const afterApps = after.map((t) => t.app);
  console.log(
    "PERSIST: apps before:",
    JSON.stringify(before),
    "after:",
    JSON.stringify(afterApps),
  );
  console.log(
    "PERSIST: focused URL after reload:",
    page.url(),
    "== tabA:",
    page.url() === tabAUrl,
  );
  await snap(page, OUT, "7-reload");

  // 6) Back/forward affects only the focused tab + URL reflects focused tab.
  const urlBeforeBack = page.url();
  await page.goBack();
  await page.waitForTimeout(800);
  const urlAfterBack = page.url();
  const labelsDuringBack: number = await tabs().evaluateAll((e) => e.length);
  await page.goForward();
  await page.waitForTimeout(800);
  const urlAfterForward = page.url();
  console.log("BACK/FWD:", {
    urlBeforeBack,
    urlAfterBack,
    urlAfterForward,
    tabsStillPresent: labelsDuringBack,
  });

  const errors = [
    ...captured.consoleErrors,
    ...captured.pageErrors.map((m) => `pageerror: ${m}`),
  ];
  console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
});
