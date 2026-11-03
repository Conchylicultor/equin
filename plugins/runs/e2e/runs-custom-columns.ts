/**
 * Proves the deployed `runs` union is sorted and filtered by a custom column
 * SERVER-side, on two surfaces listing it with two definitions (item 7
 * session 3 of research/2026-11-03-global-live-collections-item7-remaining.md
 * — a column scope per query):
 *
 *  1. seeds three backup runs (`long`, `running`, `short`) and defines ONE
 *     column id on both surfaces — a NUMBER on the runs surface (`runs`), TEXT
 *     on the Deploy Activity page (`deploy.activity`) — with each surface's
 *     own values;
 *  2. reads the `runs` window as each surface asks it (its `scope`): sorted
 *     by the column, each surface's order is its own definition's, and a
 *     filter by it narrows server-side; a scope no surface declares is
 *     refused;
 *  3. in the browser, the runs surface (the Backup panel's pinned view) and the
 *     Activity page each show the rows in their own sorted order, and a filter
 *     by the column narrows the list; a value written meanwhile moves its row,
 *     live.
 *
 * Seeded rows and cells are deleted at the end (also on failure); the
 * surfaces' config writes are put back by the harness's agent-write ledger.
 * Refuses main (it seeds rows into the deploy's database).
 *
 *   ./equin run plugins/runs/e2e/runs-custom-columns.ts [--headed]
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import {
  agentFetch,
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
import { scopedLiveColumns } from "@plugins/network/plugins/live/core";
import {
  clearCustomColumnValues,
  defineCustomColumns,
  setCustomColumnCell,
  setSurfaceConfig,
} from "@plugins/primitives/plugins/data-view/plugins/custom-columns/e2e";
import { CUSTOM_COLUMNS_SET } from "@plugins/primitives/plugins/data-view/plugins/custom-columns/core";
import { runRowKey, runs } from "@plugins/runs/core";

const OUT = arg("out") ?? "/tmp/runs-custom-columns";
const RUNS = { surface: "runs", store: "runs/runs.jsonc" };
const ACTIVITY = {
  surface: "deploy.activity",
  store: "apps/deploy/deploy-history/deploy.activity.jsonc",
};
const COLUMN = "cc-e2e-prio";

const db = openDeployDb();
const tag = `e2e-${randomBytes(3).toString("hex")}`;
const NAMES = ["long", "running", "short"] as const;
type Name = (typeof NAMES)[number];
const id = (name: Name) => `${tag}-${name}`;
const rowKey = (name: Name) => runRowKey({ kind: "backup", id: id(name) });

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await clearCustomColumnValues(RUNS.surface, COLUMN);
  await clearCustomColumnValues(ACTIVITY.surface, COLUMN);
  await db.query("DELETE FROM backup_runs WHERE id = ANY($1)", [NAMES.map(id)]);
  await db.close();
}
onBeforeFinish(cleanup);

async function cell(surface: string, name: Name, value: string): Promise<void> {
  await setCustomColumnCell({
    dataViewId: surface,
    rowKey: rowKey(name),
    columnId: COLUMN,
    value,
  });
}

/** The `runs` window at these params, as the server answers it. */
async function window(
  params: Record<string, string>,
): Promise<{ status: number; names: string[] }> {
  const res = await agentFetch(
    `/api/resources/runs?${new URLSearchParams(params).toString()}`,
  );
  if (!res.ok) return { status: res.status, names: [] };
  const body = (await res.json()) as { value: { id: string }[] };
  return {
    status: res.status,
    names: body.value.map((r) => r.id.slice(tag.length + 1)),
  };
}

/** The seeded runs in the order the page draws them (top to bottom). */
async function order(page: Page): Promise<string[]> {
  const ids = NAMES.map(id);
  const found = await page.evaluate((wanted) => {
    const tops = new Map<string, number>();
    for (const el of document.querySelectorAll(
      '[data-ui-owner^="ListView@"] *',
    )) {
      if (el.children.length > 0) continue;
      const text = el.textContent ?? "";
      for (const w of wanted) {
        if (text.includes(w) && !tops.has(w)) {
          tops.set(w, el.getBoundingClientRect().top);
        }
      }
    }
    return [...tops];
  }, ids);
  return found
    .sort((x, y) => x[1] - y[1])
    .map(([i]) => i.slice(tag.length + 1));
}

/** A list view over the seeded runs, sorted (and maybe filtered) by the column. */
function view(
  viewId: string,
  direction: "asc" | "desc",
  extra: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    id: viewId,
    name: "E2E",
    view: {
      type: "list",
      sort: [{ fieldId: COLUMN, direction }],
      filter: {
        kind: "group",
        id: `${viewId}-f`,
        conjunction: "and",
        children: [
          {
            kind: "rule",
            id: `${viewId}-tag`,
            fieldId: "trigger",
            operatorId: "contains",
            value: tag,
          },
          ...extra,
        ],
      },
    },
  };
}

try {
  await db.query(
    `INSERT INTO backup_runs (id, trigger, started_at, finished_at, status) VALUES
       ($1, $1, now() - interval '60 minutes', now() - interval '40 minutes', 'ok'),
       ($2, $2, now() - interval '10 minutes', NULL, 'running'),
       ($3, $3, now() - interval '30 minutes', now() - interval '25 minutes', 'ok')`,
    NAMES.map(id),
  );

  await withBrowser(async (h) => {
    const r = report(
      "Runs · custom columns sort and filter on two surfaces, each its own",
    );
    // One column id, two definitions: a number on the runs surface, text on
    // the Activity page — each surface's values its own.
    await defineCustomColumns(RUNS.store, [
      { id: COLUMN, label: "E2E prio", type: "number" },
    ]);
    await defineCustomColumns(ACTIVITY.store, [
      { id: COLUMN, label: "E2E prio", type: "text" },
    ]);
    // Runs: long 3, running 1, short 20 (20 > 3 as a number, not as text).
    await cell(RUNS.surface, "long", "3");
    await cell(RUNS.surface, "running", "1");
    await cell(RUNS.surface, "short", "20");
    // Activity: long "b", running "c", short "a".
    await cell(ACTIVITY.surface, "long", "b");
    await cell(ACTIVITY.surface, "running", "c");
    await cell(ACTIVITY.surface, "short", "a");

    // 2. The server's answer to each surface's query.
    const codec = runs.window.window;
    const handle = (surface: string, domain: "number" | "text") =>
      scopedLiveColumns(surface, CUSTOM_COLUMNS_SET, {
        [COLUMN]: { domain, sortable: true },
      });
    const wire = `${CUSTOM_COLUMNS_SET}.${COLUMN}`;
    const where = { trigger: { contains: tag } };
    const runsAsc = codec.encode({
      where,
      orderBy: [[wire, "asc"]],
      columns: [handle(RUNS.surface, "number")],
    } as never);
    r.ok(
      "a query naming the column carries its surface",
      runsAsc.scope === RUNS.surface,
    );
    const a = await window(runsAsc);
    r.eq("runs, sorted asc by its number column", a.names, [
      "running",
      "long",
      "short",
    ]);
    const act = await window(
      codec.encode({
        where,
        orderBy: [[wire, "desc"]],
        columns: [handle(ACTIVITY.surface, "text")],
      } as never),
    );
    r.eq("Activity, sorted desc by its text column", act.names, [
      "running",
      "long",
      "short",
    ]);
    const filtered = await window(
      codec.encode({
        where: { ...where, [wire]: { gt: 2 } },
        columns: [handle(RUNS.surface, "number")],
      } as never),
    );
    r.eq(
      "runs, filtered by its column (> 2) server-side",
      [...filtered.names].sort(),
      ["long", "short"],
    );
    const stray = await window({ ...runsAsc, scope: "no.such.surface" });
    r.ok(
      "a scope no surface declares is refused",
      stray.status >= 400 && stray.status < 500,
      String(stray.status),
    );

    // 3. In the browser: each surface its own order.
    await setSurfaceConfig(RUNS.store, "views", [view("backups", "asc")]);
    await setSurfaceConfig(ACTIVITY.store, "views", [view("recent", "desc")]);
    const { page } = await h.session({
      viewport: { width: 1600, height: 900 },
    });
    await boot(page, pathUrl("/debug/backup"), {
      marker: '[data-ui-owner^="ListView@"]',
      timeoutMs: 120_000,
      settleMs: 1000,
    });
    const onRuns = await waitFor(
      () => order(page),
      (o) => o.length === 3,
      { timeoutMs: 60_000 },
    );
    r.eq("the runs surface lists them by its number column", onRuns.value, [
      "running",
      "long",
      "short",
    ]);
    await snap(page, OUT, "runs-sorted");
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });
    // A value written meanwhile moves its row, live: running 1 → 50.
    await cell(RUNS.surface, "running", "50");
    const moved = await waitFor(
      () => order(page),
      (o) => o.join() === "long,short,running",
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a new value moves its row to its sorted place, live",
      moved.ok,
      `${JSON.stringify(moved.value)} after ${moved.waitedMs}ms`,
    );
    r.ok(
      "without a reload",
      await page.evaluate(
        () =>
          (window as unknown as { __noReload?: boolean }).__noReload === true,
      ),
    );

    await boot(page, pathUrl("/deploy/activity"), {
      marker: '[data-ui-owner^="ListView@"]',
      timeoutMs: 120_000,
      settleMs: 1000,
    });
    const onActivity = await waitFor(
      () => order(page),
      (o) => o.length === 3,
      { timeoutMs: 60_000 },
    );
    r.eq(
      "the Activity page lists them by its own text column",
      onActivity.value,
      ["running", "long", "short"],
    );
    await snap(page, OUT, "activity-sorted");

    // A filter by the column narrows the Activity list (is "b": long only).
    await setSurfaceConfig(ACTIVITY.store, "views", [
      view("recent", "desc", [
        {
          kind: "rule",
          id: "recent-prio",
          fieldId: COLUMN,
          operatorId: "is",
          value: "b",
        },
      ]),
    ]);
    const narrowed = await waitFor(
      () => order(page),
      (o) => o.join() === "long",
      { timeoutMs: 30_000 },
    );
    r.ok(
      "filtered by its column, the Activity page lists only the match",
      narrowed.ok,
      JSON.stringify(narrowed.value),
    );
    await snap(page, OUT, "activity-filtered");
    await r.finish();
  });
} finally {
  await cleanup();
}
