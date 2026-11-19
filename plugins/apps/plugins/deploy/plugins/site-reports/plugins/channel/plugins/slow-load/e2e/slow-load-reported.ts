/**
 * A visitor's slow page load reaches the site's report intake, and an
 * automated browser's never lands beside it:
 *  1. a browser posing as a visitor's (`navigator.webdriver` false) opens the
 *     site on a throttled network and CPU, so the page is ready well past
 *     the 3 s bar;
 *  2. its report channel posts a batch to POST /api/site-reports holding a
 *     `slow-page-load` report, marked `automated: false`;
 *  3. an automated browser (webdriver true, nothing faked) loads the same way
 *     and its batch says `automated: true`;
 *  4. on a local deploy only (the site's database is readable there): after
 *     the intake's flush window, `site_reports` holds the visitor's
 *     slow-page-load row and `site_report_drops` counts the automated batch.
 *     On the public site (`--url https://equin.ai`) the row is read by the
 *     computer's hourly mirror pull instead (Debug → Reports, Website
 *     visitors).
 *
 * Manual only:
 *   ./equin build --composition website
 *   ./equin run plugins/apps/plugins/deploy/plugins/site-reports/plugins/channel/plugins/slow-load/e2e/slow-load-reported.ts --composition website
 *   ./equin run <this script> --url https://equin.ai
 */
import type { Page, Request } from "playwright";
import {
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { waitFor } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { namespaceFromHost } from "@plugins/infra/plugins/namespace/core";
import { SITE_REPORT_LIMITS } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";

const SEND_TIMEOUT_MS = 90_000;

interface Batch {
  /** The intake's answer, once it came (the page must stay open until then). */
  answer: Promise<string>;
  automated: boolean | undefined;
  kinds: string[];
  messages: string[];
}

/** Every batch the page posts to the site's intake, parsed. */
function tapBatches(page: Page): Batch[] {
  const batches: Batch[] = [];
  page.on("request", (req: Request) => {
    if (new URL(req.url()).pathname !== "/api/site-reports") return;
    const body = JSON.parse(req.postData() ?? "{}") as {
      automated?: boolean;
      reports?: { kind: string; message: string }[];
    };
    batches.push({
      answer: req.response().then((res) => (res ? res.text() : "no response")),
      automated: body.automated,
      kinds: (body.reports ?? []).map((r) => r.kind),
      messages: (body.reports ?? []).map((r) => r.message),
    });
  });
  return batches;
}

/** A slow network and CPU, so the load is past the bar on any machine. */
async function throttle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 400,
    downloadThroughput: (1.5 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
}

async function loadAndCollect(page: Page): Promise<Batch | undefined> {
  const batches = tapBatches(page);
  await throttle(page);
  await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });
  const sent = await waitFor(
    async () => batches.find((b) => b.kinds.includes("slow-page-load")),
    (b) => b !== undefined,
    { timeoutMs: SEND_TIMEOUT_MS },
  );
  if (sent.value) console.log(`intake answered: ${await sent.value.answer}`);
  return sent.value;
}

await withBrowser(async (h) => {
  const r = report("site-reports: a visitor's slow page load is reported");
  // A namespace of this machine's gateway (a local build), or the public site.
  const local = namespaceFromHost(new URL(pathUrl("/")).host) !== null;

  // ── 1–2. a visitor's browser ───────────────────────────────────────
  const visitor = await h.session();
  await visitor.page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: () => false,
    });
  });
  const vBatch = await loadAndCollect(visitor.page);
  r.ok(
    "the visitor's page sends a slow-page-load report",
    vBatch !== undefined,
  );
  r.eq("its batch says it is not automated", vBatch?.automated, false);
  const message = vBatch?.messages[vBatch.kinds.indexOf("slow-page-load")];
  r.ok(
    "the message names the load time and the browser",
    /^Slow page load: (ready|not ready) after \d+\.\d s .*; \w+\/\w+/.test(
      message ?? "",
    ),
    message,
  );
  await visitor.context.close();

  // ── 3. an automated browser ────────────────────────────────────────
  const bot = await h.session();
  const aBatch = await loadAndCollect(bot.page);
  r.eq("an automated page's batch says so", aBatch?.automated, true);
  await bot.context.close();

  // ── 4. what the site's server kept ─────────────────────────────────
  if (!local) {
    console.log(
      "public site: the row is read by the computer's hourly mirror pull (Debug → Reports, Website visitors)",
    );
    await r.finish();
    return;
  }
  const db = openDeployDb();
  onBeforeFinish(() => db.close());
  const rows = await waitFor(
    async () =>
      db.query<{ message: string; count: number }>(
        "SELECT message, count FROM site_reports WHERE kind = 'slow-page-load'",
      ),
    (found) => found.some((row) => row.message === message),
    { timeoutMs: SITE_REPORT_LIMITS.windowMs + 30_000, intervalMs: 2_000 },
  );
  r.ok(
    "the site's server holds the visitor's slow load",
    rows.ok,
    rows.value.map((row) => `${row.count}× ${row.message}`).join(" | "),
  );
  const automated = await db.query<{ n: number }>(
    "SELECT coalesce(sum(count), 0)::int AS n FROM site_report_drops WHERE reason = 'automated'",
  );
  r.ok(
    "the automated batch is counted as a drop, not stored",
    (automated[0]?.n ?? 0) > 0 &&
      !rows.value.some((row) => row.message.startsWith("(automated browser)")),
    `automated drops: ${automated[0]?.n ?? 0}`,
  );
  await r.finish();
});
