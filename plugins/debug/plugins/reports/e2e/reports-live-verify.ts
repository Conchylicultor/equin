/**
 * The Reports pane is LIVE: a report written by the backend reaches the open
 * list and detail pane through the reports change producer — no reload, no
 * refetch, no revision tick — at most one coalesced flush (2 s) later.
 *
 * Each submit goes through `POST /api/reports` with a message carrying this
 * run's unique tag, so its row is its own fingerprint:
 *
 *  1. a new report appears in the open list within the 2 s window + δ;
 *  2. a repeat of it moves the row's count to ×2, in place;
 *  3. with its detail pane open, a submit moves the pane's count;
 *  4. after a burst of 30 (rate-limited past the velocity threshold — the bell
 *     goes quiet, the row does not), the final count shows;
 *  5. the kind / source it was filed under are in the collection's `:groups`
 *     grouping (the Filter control's options read exactly that; their
 *     value-sorted order is pinned by data-view's facet tests);
 *  6. a noise report (a ResizeObserver message — the built-in noise rule) is
 *     left out of the `noise = false` window, and stays in the unfiltered one.
 *
 * The page is never reloaded between steps. Investigate is covered by the DB
 * suites (it files a real task).
 *
 * Refuses main: every submit writes a real row into the target's `reports`
 * table. The rows stay (the table's 7-day retention sweeps them); find them by
 * the tag the run prints.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/debug/plugins/reports/e2e/reports-live-verify.ts [--headed]
 */
import type { Page } from "playwright";
import {
  agentFetch,
  arg,
  boot,
  pathUrl,
  report,
  snap,
  targetNamespace,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import {
  reportDetailRoute,
  reportsList,
  reportsRootRoute,
} from "@plugins/reports/core";

const OUT = arg("out") ?? "/tmp/reports-live";
const BOOT_TIMEOUT_MS = 120_000;
/** The producer's coalescing window plus a delivery margin. */
const LIVE_MS = 2000 + 4000;
const BURST = 30;
const KIND = "crash";
const SOURCE = "browser-error";

if (String(targetNamespace()) === "singularity") {
  throw new Error(
    "refusing to file synthetic reports into main — run this against a worktree deploy",
  );
}

const r = report("Reports · live list and detail through the reports producer");
const tag = `ReportsLiveVerify_${Date.now()}`;
r.note(`tag: ${tag}`);

/** File one report; returns its row id. */
async function submit(message: string, errorType = tag): Promise<string> {
  const res = await agentFetch("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: KIND,
      source: SOURCE,
      message,
      // A declared identity with no stack: the fingerprint is the error type,
      // so every submit of one tag lands on one row.
      data: { errorType, stack: null },
    }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/reports → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { outcome: string; reportId?: string };
  if (body.outcome !== "recorded" || body.reportId === undefined) {
    throw new Error(`report not recorded: ${JSON.stringify(body)}`);
  }
  return body.reportId;
}

/**
 * The `×N` count rendered nearest the visible text `needle` inside `scope`:
 * walk up from the text until an ancestor holds a `×N` badge — the detail
 * pane's header is the first such ancestor once the count is past 1 (the list
 * is read by row marker instead: `rowCount`). `null`
 * when the text is not on screen; `1` when no badge is near it (a count of 1
 * renders none).
 */
async function countNear(
  page: Page,
  needle: string,
  scope: string,
): Promise<number | null> {
  return await page.evaluate(
    ({ needle, scope }) => {
      const root = document.querySelector(scope);
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      while (node && !(node.textContent ?? "").includes(needle)) {
        node = walker.nextNode();
      }
      if (!node) return null;
      for (
        let el = node.parentElement;
        el && el !== root;
        el = el.parentElement
      ) {
        const badge = [...el.querySelectorAll("span")].find((s) =>
          /^×\d+$/.test((s.textContent ?? "").trim()),
        );
        if (badge) return Number((badge.textContent ?? "").trim().slice(1));
      }
      return 1;
    },
    { needle, scope },
  );
}

/**
 * The `×N` count in the list row of report `id`, addressed by the row's
 * `data-row-key` (the DataView table's row marker): `null` while the row is not
 * rendered, `1` when it carries no badge (a count of 1 renders none).
 */
async function rowCount(page: Page, id: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const row = document.querySelector(`[data-row-key="${CSS.escape(id)}"]`);
    if (!row) return null;
    const badge = [...row.querySelectorAll("span")].find((s) =>
      /^×\d+$/.test((s.textContent ?? "").trim()),
    );
    return badge ? Number((badge.textContent ?? "").trim().slice(1)) : 1;
  }, id);
}

/**
 * Why the list shows no row for `id`: the body's own placeholder text (a view
 * whose saved sort or filter the live source refuses, a failed read), or the
 * last count seen.
 */
async function listDiagnosis(page: Page, seen: unknown): Promise<string> {
  const rows = await page.locator("[data-row-key]").count();
  const body = (await page.locator("body").innerText()).slice(-300);
  return `saw ${String(seen)}; ${rows} row(s) rendered; list text: ${JSON.stringify(body)}`;
}

/** A `reports.list` sibling read over HTTP (`/api/resources/<key>?<params>`). */
async function readResource(
  key: string,
  params: Record<string, string>,
): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const res = await agentFetch(
    `/api/resources/${encodeURIComponent(key)}${qs ? `?${qs}` : ""}`,
  );
  if (!res.ok)
    throw new Error(`GET ${key} → ${res.status} ${await res.text()}`);
  return ((await res.json()) as { value: unknown }).value;
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl(reportsRootRoute.link(debugApp, {})), {
    timeoutMs: BOOT_TIMEOUT_MS,
  });
  // 1 — a new report appears, live.
  const first = `${tag} first`;
  const t0 = Date.now();
  const reportId = await submit(first);
  const appeared = await waitFor(
    () => rowCount(page, reportId),
    (n) => n === 1,
    { timeoutMs: LIVE_MS },
  );
  r.ok(
    `1. the new report appears in the open list (${Date.now() - t0} ms)`,
    appeared.ok,
    appeared.ok ? "" : await listDiagnosis(page, appeared.value),
  );

  // 2 — a repeat moves the count in place.
  await submit(`${tag} repeat`);
  const two = await waitFor(
    () => rowCount(page, reportId),
    (n) => n === 2,
    { timeoutMs: LIVE_MS },
  );
  r.ok(
    "2. a repeat moves the row's count to ×2",
    two.ok,
    two.ok ? "" : await listDiagnosis(page, two.value),
  );

  // 3 — the detail pane's count moves while it is open.
  await page.goto(pathUrl(reportDetailRoute.link(debugApp, { reportId })));
  await page
    .getByText("Raw data")
    .first()
    .waitFor({ timeout: BOOT_TIMEOUT_MS });
  await submit(`${tag} detail`);
  const three = await waitFor(
    () => countNear(page, `${tag} detail`, "body"),
    (n) => n === 3,
    { timeoutMs: LIVE_MS },
  );
  r.ok(
    "3. an open detail pane's count moves (×3)",
    three.ok,
    `saw ${three.value}`,
  );

  // 4 — a burst lands as its final count (rate-limited writes still route).
  for (let i = 0; i < BURST; i++) await submit(`${tag} burst ${i}`);
  const finalCount = 3 + BURST;
  const burst = await waitFor(
    () => countNear(page, `${tag} burst ${BURST - 1}`, "body"),
    (n) => n === finalCount,
    { timeoutMs: LIVE_MS },
  );
  r.ok(
    `4. after a burst of ${BURST}, the final count shows (×${finalCount})`,
    burst.ok,
    `saw ${burst.value}`,
  );
  await snap(page, OUT, "detail-after-burst");

  // 5 — the kind / source are among the filter options' grouping.
  const g = reportsList.groups.groups;
  const values = async (groupBy: "kind" | "source") =>
    (
      (await readResource(reportsList.groups.key, g.encode({ groupBy }))) as {
        value: unknown;
      }[]
    ).map((x) => String(x.value));
  const kinds = await values("kind");
  const sources = await values("source");
  r.ok(`5. "${KIND}" is a kind option`, kinds.includes(KIND), kinds.join(", "));
  r.ok(
    `5. "${SOURCE}" is a source option`,
    sources.includes(SOURCE),
    sources.join(", "),
  );

  // 6 — a noise report is filtered out by Noise = false.
  const noiseId = await submit(
    `ResizeObserver loop completed with undelivered notifications (${tag})`,
    `${tag}_noise`,
  );
  const w = reportsList.window.window;
  const ids = async (where?: { noise: { eq: boolean } }) =>
    (
      (await readResource(
        reportsList.key,
        w.encode({ ...(where ? { where } : {}), limit: 500 }),
      )) as { id: string }[]
    ).map((row) => row.id);
  const all = await waitFor(
    () => ids(),
    (xs) => xs.includes(noiseId),
    { timeoutMs: LIVE_MS },
  );
  r.ok("6. the noise report is listed unfiltered", all.ok);
  const signal = await ids({ noise: { eq: false } });
  r.ok(
    "6. …and left out of the Noise = false window",
    !signal.includes(noiseId),
  );
  r.ok("6. …which still lists the run's own report", signal.includes(reportId));
});

await r.finish();
