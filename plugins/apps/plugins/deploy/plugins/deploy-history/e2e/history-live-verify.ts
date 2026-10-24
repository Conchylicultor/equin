/**
 * A deployment's History is a LIVE window sorted and filtered by a custom
 * column server-side (research/2026-09-29-global-scoped-change-routing.md P3):
 * a custom value written elsewhere — the API, as a second tab's cell editor
 * would — moves the row, drops it out or brings it back, without a reload.
 *
 *  1. seeds three finished runs of this deploy's first deployment (pinned
 *     release ids `<run>-a|b|c`, so each row is findable by its release badge);
 *  2. defines a number custom column on the history surface and gives the runs
 *     3 / 1 / 2; sets the Recent view to sort by it ascending and keep `> 0`;
 *  3. opens the deployment — the list reads b, c, a;
 *  4. a → 0: a leaves (the filter); a → 5: it comes back, last;
 *     c → 9: c moves to the bottom; each in place (a no-reload marker);
 *  5. a run's status flips to failed in the database: its row's badge follows.
 *
 * The seeded runs and their cells are deleted at the end (also on failure);
 * the surface's config writes are put back by the harness's agent-write ledger.
 * Refuses main (it seeds rows into the deploy's database).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/deploy/plugins/deploy-history/e2e/history-live-verify.ts [--headed]
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import {
  arg,
  boot,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  clearCustomColumnValues,
  defineCustomColumns,
  setCustomColumnCell,
  setSurfaceConfig,
} from "@plugins/primitives/plugins/data-view/plugins/custom-columns/e2e";

const OUT = arg("out") ?? "/tmp/deploy-history-live";
const SURFACE = "deploy.deployment.history";
const STORE = "apps/deploy/deploy-history/deploy.deployment.history.jsonc";
const COLUMN = "cc-e2e-rank";

const db = openDeployDb();
const prefix = `e2e-${randomBytes(3).toString("hex")}`;
const run = (name: string) => `${prefix}-${name}`;

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await clearCustomColumnValues(SURFACE, COLUMN);
  await db.query("DELETE FROM deploy_runs WHERE id LIKE 'e2e-%'");
  await db.close();
}
onBeforeFinish(cleanup);

/** A seeded run's release badge (its pinned release id IS its id). */
const badgeOf = (page: Page, name: string) =>
  page.getByText(run(name), { exact: true });

/** The text of a seeded run's row: the nearest ancestor holding its status badge too. */
async function rowText(page: Page, name: string): Promise<string> {
  const row = badgeOf(page, name)
    .first()
    .locator(
      "xpath=ancestor::*[contains(., 'Succeeded') or contains(., 'Failed') or contains(., 'Running')][1]",
    );
  return (await row.count()) === 0 ? "" : ((await row.textContent()) ?? "");
}

/**
 * The seeded runs on screen, top to bottom — one DOM read, so a row leaving
 * between two queries cannot stall it.
 */
async function order(page: Page): Promise<string[]> {
  const names = ["a", "b", "c"];
  const ids = names.map(run);
  const found = await page.evaluate((wanted) => {
    const out: [string, number][] = [];
    for (const el of document.querySelectorAll("body *")) {
      const text = el.textContent?.trim() ?? "";
      if (el.children.length === 0 && wanted.includes(text)) {
        out.push([text, el.getBoundingClientRect().top]);
      }
    }
    return out;
  }, ids);
  return found
    .sort((x, y) => x[1] - y[1])
    .map(([id]) => names[ids.indexOf(id)]!);
}

async function cell(name: string, value: number): Promise<void> {
  await setCustomColumnCell({
    dataViewId: SURFACE,
    rowKey: run(name),
    columnId: COLUMN,
    value: String(value),
  });
}

try {
  // A killed run's leftovers first.
  await db.query("DELETE FROM deploy_runs WHERE id LIKE 'e2e-%'");
  const [deployment] = await db.query<{
    id: string;
    server_id: string;
    composition_id: string;
  }>(
    "SELECT id, server_id, composition_id FROM deploy_deployments ORDER BY id LIMIT 1",
  );
  if (deployment === undefined) {
    throw new Error(
      `no deployment in "${db.namespace}" — the History section has nothing to list`,
    );
  }
  for (const [name, minutesAgo] of [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ] as const) {
    await db.query(
      `INSERT INTO deploy_runs (id, deployment_id, server_id, composition_id, verb, release_run_id,
                                status, started_at, finished_at, exit_code, launched_from)
       VALUES ($1, $2, $3, $4, 'converge', $1, 'succeeded',
               now() - make_interval(mins => $5::int), now(), 0, $6)`,
      [
        run(name),
        deployment.id,
        deployment.server_id,
        deployment.composition_id,
        minutesAgo,
        db.namespace,
      ],
    );
  }
  await withBrowser(async (h) => {
    const r = report(
      "deploy history — sorted and filtered by a custom column, live",
    );
    // Config writes inside the harness: it reverts agent writes left before it
    // opened, and puts these back when the run ends.
    await defineCustomColumns(STORE, [
      { id: COLUMN, label: "E2E rank", type: "number" },
    ]);
    await setSurfaceConfig(STORE, "views", [
      {
        id: "recent",
        name: "Recent",
        view: {
          type: "list",
          sort: [{ fieldId: COLUMN, direction: "asc" }],
          filter: {
            kind: "group",
            id: "f-e2e",
            conjunction: "and",
            children: [
              {
                kind: "rule",
                id: "r-e2e",
                fieldId: COLUMN,
                operatorId: ">",
                value: 0,
              },
            ],
          },
        },
      },
      {
        id: "all",
        name: "All",
        view: {
          type: "table",
          sort: [{ fieldId: "startedAt", direction: "desc" }],
        },
      },
    ]);
    await cell("a", 3);
    await cell("b", 1);
    await cell("c", 2);
    const { page } = await h.session();
    await boot(
      page,
      pathUrl(`/deploy/server/${deployment.server_id}/dep/${deployment.id}`),
      { marker: "text=History", timeoutMs: 120_000, settleMs: 500 },
    );
    // The deployment pane's sections open collapsed.
    await page.getByText("History", { exact: true }).first().click();

    const initial = await waitFor(
      () => order(page),
      (o) => o.join() === "b,c,a",
      { timeoutMs: 60_000 },
    );
    r.eq("sorted by the custom column (b 1, c 2, a 3)", initial.value, [
      "b",
      "c",
      "a",
    ]);
    await snap(page, OUT, "seeded");
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });

    await cell("a", 0);
    const left = await waitFor(
      () => order(page),
      (o) => !o.includes("a"),
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a value failing the filter drops the row, live",
      left.ok,
      `${JSON.stringify(left.value)} after ${left.waitedMs}ms`,
    );

    await cell("a", 5);
    const back = await waitFor(
      () => order(page),
      (o) => o.join() === "b,c,a",
      { timeoutMs: 30_000 },
    );
    r.eq("a value passing it brings the row back, in order", back.value, [
      "b",
      "c",
      "a",
    ]);

    await cell("c", 9);
    const moved = await waitFor(
      () => order(page),
      (o) => o[2] === "c",
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a new value moves the row to its sorted place, live",
      moved.ok,
      `${JSON.stringify(moved.value)} after ${moved.waitedMs}ms`,
    );
    r.eq("the order after the move", moved.value, ["b", "a", "c"]);

    await db.query(
      "UPDATE deploy_runs SET status = 'failed', exit_code = 1, message = 'e2e: refused' WHERE id = $1",
      [run("b")],
    );
    const failed = await waitFor(
      () => rowText(page, "b"),
      (text) => text.includes("Failed"),
      { timeoutMs: 30_000 },
    );
    r.ok("a run's status flip shows on its row, live", failed.ok);
    await snap(page, OUT, "after");

    const noReload = await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    );
    r.ok("the page never reloaded", noReload);
    await r.finish();
  });
} finally {
  await cleanup();
}
