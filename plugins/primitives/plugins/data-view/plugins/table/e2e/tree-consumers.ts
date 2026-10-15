/**
 * The first surfaces moved from the tree view to the nested table (tree-table
 * plan P4, batch 1), checked on the deployed app: the agents list, the
 * settings config nav, a task's dependency tree, and the running-agents band
 * of a conversation (`--conversation <id>`; when nothing runs, its transcript's
 * agents stat opens the band on every agent; skipped when it has none).
 *
 * For each: the rows are a nested table (`treegrid`), the tree chrome the
 * surface asks for is there (expand-all toolbar, root Add, row menu,
 * selection checkbox), its rows hold still once loaded (no render loop: the
 * quietest of three 1s windows of DOM mutations under the grid), and no page
 * error.
 *
 * Manual only. Run after `./singularity build`:
 *   ./singularity run plugins/primitives/plugins/data-view/plugins/table/e2e/tree-consumers.ts \
 *     [--task <id>] [--conversation <id>] [--color-scheme light|dark] [--out /tmp/tree-consumers]
 */
import type { Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/tree-consumers";
const SCHEME = arg("color-scheme") === "dark" ? "dark" : "light";
const TASK = arg("task") ?? "task-1778773377979-72ph6s";
const CONVERSATION = arg("conversation");

const GRID = "[role='treegrid']";

/** DOM mutations under the first treegrid over `ms` of no interaction. */
const mutationsOver = (page: Page, ms: number): Promise<number> =>
  page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const grid = document.querySelector("[role='treegrid']");
        if (!grid) return resolve(-1);
        let n = 0;
        const obs = new MutationObserver((records) => (n += records.length));
        obs.observe(grid, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        setTimeout(() => {
          obs.disconnect();
          resolve(n);
        }, ms);
      }),
    ms,
  );

/** Row heights of the first few painted rows (px). */
const rowHeights = (page: Page): Promise<number[]> =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "[role='treegrid'] [data-tree-row]",
      ),
    ]
      .slice(0, 5)
      .map((el) => Math.round(el.getBoundingClientRect().height)),
  );

await withBrowser(async (h) => {
  const r = report("nested table — tree consumers (P4 batch 1)");
  const { page, captured } = await h.session({
    colorScheme: SCHEME,
    viewport: { width: 1280, height: 900 },
  });

  async function settle(name: string) {
    await page
      .locator(`${GRID} [data-tree-row]`)
      .first()
      .waitFor({ state: "visible" });
    await page.waitForTimeout(1500);
    r.ok(`${name}: rows are a nested table (treegrid)`, true);
    // A render loop churns in every window; a live read landing churns in
    // one. So the quietest of three windows is what must be still.
    const windows: number[] = [];
    for (let i = 0; i < 3; i++) windows.push(await mutationsOver(page, 1000));
    const n = Math.min(...windows);
    r.ok(
      `${name}: rows hold still once loaded (${windows.join(" / ")} mutations per 1s window)`,
      n >= 0 && n < 20,
      String(windows),
    );
    r.note(`${name}: row heights ${JSON.stringify(await rowHeights(page))}`);
  }

  // --- Agents list ------------------------------------------------------------
  await boot(page, pathUrl("/agents/agents"), { marker: GRID, settleMs: 800 });
  await settle("agents");
  r.ok(
    "agents: expand-all toolbar",
    (await page
      .getByRole("button", { name: /^(Expand|Collapse) all$/ })
      .count()) > 0,
  );
  r.ok(
    'agents: root Add ("Agent")',
    (await page.getByRole("button", { name: "Agent", exact: true }).count()) ===
      1,
  );
  const firstAgent = page.locator(`${GRID} [data-tree-row]`).first();
  await firstAgent.hover();
  r.ok(
    "agents: the row menu is in the row's cluster",
    (await firstAgent.getByLabel("More actions").count()) === 1,
  );
  r.ok(
    "agents: the selection checkbox heads the row",
    (await firstAgent.getByRole("checkbox").count()) === 1,
  );
  await snap(page, OUT, `${SCHEME}-agents`);

  // --- Config nav ---------------------------------------------------------------
  await boot(page, pathUrl("/settings/config"), {
    marker: GRID,
    settleMs: 800,
  });
  await settle("config nav");
  r.ok(
    "config nav: expand-all toolbar",
    (await page
      .getByRole("button", { name: /^(Expand|Collapse) all$/ })
      .count()) > 0,
  );
  await snap(page, OUT, `${SCHEME}-config-nav`);

  // --- Dependency tree ----------------------------------------------------------
  await boot(page, pathUrl(`/agents/tasks/t/${TASK}`), {
    marker: "text=Dependency tree",
    settleMs: 800,
  });
  await page.getByText("Dependency tree", { exact: true }).click();
  const deps = page.locator(GRID).last();
  await deps.locator("[data-tree-row]").first().waitFor({ state: "visible" });
  await page.waitForTimeout(1500);
  r.ok(
    "deps: rows are a nested table (treegrid)",
    (await deps.locator("[data-tree-row]").count()) > 1,
  );
  await snap(page, OUT, `${SCHEME}-deps`);

  // --- Running agents -----------------------------------------------------------
  if (CONVERSATION) {
    await boot(page, pathUrl(`/agents/c/${CONVERSATION}`), {
      // The band, or the transcript's agents stat that opens it.
      marker: `${GRID}, button:has-text("agents ·"), button:has-text("agent ·")`,
      settleMs: 2500,
    });
    const band = page.locator(GRID);
    // Nothing running: the transcript's agents stat shows every agent, finished
    // or not, in the same band.
    const stat = page.getByRole("button", { name: / agents? · / }).first();
    if ((await band.count()) === 0 && (await stat.count()) > 0) {
      await stat.click();
      await page.waitForTimeout(1500);
    }
    if ((await band.count()) === 0) {
      r.note(
        "running agents: no band (no agent in this conversation) — skipped",
      );
    } else {
      await settle("running agents");
      await snap(page, OUT, `${SCHEME}-running-agents`);
    }
  }

  if (captured.failedRequests.length > 0) {
    r.note(
      `requests that got no response: ${captured.failedRequests.join(", ")}`,
    );
  }
  const errors = [
    ...captured.pageErrors,
    ...captured.consoleErrors.filter((e) => !/Failed to load resource/.test(e)),
  ];
  r.ok("no page or console errors", errors.length === 0, errors.join("\n"));
  await r.finish();
});
