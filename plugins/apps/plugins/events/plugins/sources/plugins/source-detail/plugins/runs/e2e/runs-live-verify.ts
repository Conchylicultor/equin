/**
 * Proves the run ledger is a LIVE window (`events.source-runs`), sorted and
 * filtered by a custom column server-side, with no reload:
 *
 *  1. seeds three failed runs on a source (each run's error IS its id, so its
 *     row is findable by the text the list renders for a failure);
 *  2. defines a number custom column on the runs surface, gives the runs
 *     3 / 1 / 2, and sets the landing view to sort by it ascending and keep
 *     `> 0`; opens the source — the list reads b, c, a;
 *  3. a → 0: a leaves (the filter); a → 5: it comes back, last; c → 9: c moves
 *     to the bottom; each in place;
 *  4. a fourth run lands in the database — the very insert a refresh's
 *     run-ledger makes at the end of a run — with a value: it appears in its
 *     sorted place. (Seeded rather than a real "Refresh now", which fetches a
 *     live page and may pay for a model call: the claim is about the ledger
 *     write reaching the screen, and the seeded insert is that write.)
 *
 * The load-bearing assertion is the NO-RELOAD one: a marker stamped on
 * `window` before the first live change must survive to the end, or "the row
 * is there" could equally mean "the page came back with fresh data".
 *
 * The seeded runs and their cells are deleted at the end (also on failure);
 * the surface's config writes are put back by the harness's agent-write ledger.
 * Refuses main (it seeds rows into the deploy's database).
 *
 * Manual only, like every script under `e2e/`:
 *
 *   ./equin run plugins/apps/plugins/events/plugins/sources/plugins/source-detail/plugins/runs/e2e/runs-live-verify.ts [--source <sourceId>] [--headed]
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

const OUT = arg("out") ?? "/tmp/runs-live";
const SURFACE = "events.source-runs";
const STORE = "apps/events/sources/source-detail/runs/events.source-runs.jsonc";
const COLUMN = "cc-e2e-rank";

const db = openDeployDb();
const prefix = `e2e-${randomBytes(3).toString("hex")}`;
const run = (name: string) => `${prefix}-${name}`;
const NAMES = ["a", "b", "c", "d"] as const;

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await clearCustomColumnValues(SURFACE, COLUMN);
  await db.query("DELETE FROM event_source_runs WHERE id LIKE 'e2e-%'");
  await db.close();
}
onBeforeFinish(cleanup);

async function seedRun(
  sourceId: string,
  name: string,
  minutesAgo: number,
): Promise<void> {
  await db.query(
    `INSERT INTO event_source_runs (id, source_id, started_at, finished_at, outcome, error, duration_ms)
     VALUES ($1, $2, now() - make_interval(mins => $3::int), now(), 'failed', $1, 1000)`,
    [run(name), sourceId, minutesAgo],
  );
}

/**
 * The seeded runs on screen, top to bottom — one DOM read, so a row leaving
 * between two queries cannot stall it. A failed run's row renders its error,
 * which is the run's id.
 */
async function order(page: Page): Promise<string[]> {
  const ids = NAMES.map(run);
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
    .map(([id]) => NAMES[ids.indexOf(id)]!);
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
  await db.query("DELETE FROM event_source_runs WHERE id LIKE 'e2e-%'");
  const named = arg("source");
  const [source] = await db.query<{ id: string }>(
    named === undefined
      ? "SELECT id FROM event_sources ORDER BY created_at LIMIT 1"
      : "SELECT id FROM event_sources WHERE id = $1",
    named === undefined ? [] : [named],
  );
  if (source === undefined) {
    throw new Error(
      named === undefined
        ? `no event source in "${db.namespace}" — add one (or pass --source)`
        : `no event source "${named}" in "${db.namespace}"`,
    );
  }
  for (const [name, minutesAgo] of [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ] as const) {
    await seedRun(source.id, name, minutesAgo);
  }

  await withBrowser(async (h) => {
    const r = report(
      "Events · Runs list is live, sorted and filtered by a custom column",
    );
    // Config writes inside the harness: it reverts agent writes left before it
    // opened, and puts these back when the run ends.
    await defineCustomColumns(STORE, [
      { id: COLUMN, label: "E2E rank", type: "number" },
    ]);
    await setSurfaceConfig(STORE, "views", [
      {
        id: "ranked",
        name: "Ranked",
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
      { id: "all", name: "All", view: { type: "list" } },
    ]);
    await cell("a", 3);
    await cell("b", 1);
    await cell("c", 2);

    const { page } = await h.session({
      viewport: { width: 1600, height: 900 },
    });
    await boot(page, pathUrl(`/events/sources/source/${source.id}`), {
      marker: '[data-ui-owner^="ListView@"]',
      timeoutMs: 120_000,
      settleMs: 1000,
    });

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
    r.eq("a new value moves the row to its sorted place, live", moved.value, [
      "b",
      "a",
      "c",
    ]);

    // A run landing: the ledger insert a refresh makes, plus its cell.
    await cell("d", 4);
    await seedRun(source.id, "d", 0);
    const landed = await waitFor(
      () => order(page),
      (o) => o.join() === "b,d,a,c",
      { timeoutMs: 30_000 },
    );
    r.eq("a run that lands appears in its sorted place, live", landed.value, [
      "b",
      "d",
      "a",
      "c",
    ]);
    await snap(page, OUT, "after-custom");

    const noReload = await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    );
    r.ok("the page never reloaded", noReload);
    await r.finish();
  });
} finally {
  await cleanup();
}
