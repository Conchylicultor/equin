// End-to-end boot verification for a *packaged* release bundle.
//
// A staged/self-contained release (`./equin release ... --dev`, or the
// Tauri `.app`'s embedded bundle) brings up its own gateway + embedded Postgres
// + backend and serves the SPA single-origin. Process-liveness alone doesn't
// prove the app is usable — the original desktop bug was "Starting… → black
// screen": the stack was up, but the SPA never mounted on the bare
// default-namespace route the webview navigates to. This harness loads that
// exact URL in headless Chromium and asserts the app actually renders, with no
// console errors, no failed requests, and no gateway 502/404 storm.
//
// It is stage-agnostic: point it at the subdomain URL (dev/preview,
// `http://<comp>.localhost:<port>`) or the bare default-namespace URL the Tauri
// shell uses (`http://localhost:<port>/`). The bare URL is the one that
// reproduces the desktop path — always verify that one for a release.
//
// Unlike every other e2e script, `--url` is REQUIRED and never defaults to the
// current worktree's gateway: the target here is a staged bundle on its own
// port, so a defaulted base would silently verify the wrong server.
//
// Usage:
//   ./equin run plugins/release/e2e/release-boot-verify.ts --url <url> \
//     [--expect-selector <css>] [--expect-text <substr>] \
//     [--settle <ms>] [--wait <ms>] [--out <path>] [--color-scheme dark|light]
//
// Exit code 0 = PASS, 1 = FAIL (any hard check failed), 2 = bad usage.
//
// Example (faithful desktop repro against a staged web --dev bundle on :9123):
//   ./equin run plugins/release/e2e/release-boot-verify.ts \
//     --url http://localhost:9123/ \
//     --expect-selector "[data-app-tab]" \
//     --out /tmp/sonata-release

import {
  arg,
  detectOsColorScheme,
  numArg,
  report,
  requestFailure,
  requireArg,
  withBrowser,
  type ColorScheme,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const USAGE =
  "Usage: bun plugins/release/e2e/release-boot-verify.ts --url <url> [--expect-selector <css>] [--expect-text <substr>] [--settle <ms>] [--out <path>]";

const url = requireArg("url", USAGE);
const expectSelector = arg("expect-selector");
const expectText = arg("expect-text");
const settleMs = numArg("settle", 15000); // window watched for a 502/404 storm
const waitMs = numArg("wait", 8000); // initial settle before the render assertion
const out = arg("out", "/tmp/release-boot");
const [viewportW = 1400, viewportH = 900] = arg("viewport", "1400x900")
  .split("x")
  .map(Number);
const colorScheme: ColorScheme =
  arg("color-scheme", detectOsColorScheme()) === "dark" ? "dark" : "light";
// How many failures on one backend path prefix count as a "storm".
const STORM_THRESHOLD = numArg("storm-threshold", 3);

// Bucket a request/response URL by the gateway path class we care about.
type Bucket = "ws" | "api" | "zero" | "static" | "other";
type StormBucket = "api" | "ws" | "zero";

function bucket(u: string): Bucket {
  try {
    const p = new URL(u).pathname;
    if (p.startsWith("/ws/")) return "ws";
    if (p.startsWith("/api/")) return "api";
    if (p.startsWith("/zero")) return "zero";
    return "static";
    // eslint-disable-next-line promise-safety/no-bare-catch -- "other" IS the discriminated verdict for a URL that cannot be parsed: this is a classifier over an untrusted browser-supplied string, and every parse failure maps to the same "not one of the backend path classes" bucket. Propagating would abort the storm check over a single malformed request URL.
  } catch {
    return "other";
  }
}

function isStormBucket(b: Bucket): b is StormBucket {
  return b === "api" || b === "ws" || b === "zero";
}

interface RequestFailure {
  url: string;
  bucket: Bucket;
  reason: string;
}
interface BadResponse {
  url: string;
  bucket: Bucket;
  status: number;
}

const requestFailures: RequestFailure[] = [];
const badResponses: BadResponse[] = [];

await withBrowser(async (h) => {
  const { page, captured } = await h.session({
    viewport: { width: viewportW, height: viewportH },
    colorScheme,
  });
  const { consoleErrors, pageErrors } = captured;

  page.on("requestfailed", (req) => {
    // `requestFailure` drops Chromium's empty-body artifact (a successful 204
    // reported as ERR_ABORTED). What remains never got a response; keep the raw
    // reason so the report can tell a real dial failure from a navigation abort.
    const reason = requestFailure(req);
    if (reason === null) return;
    requestFailures.push({ url: req.url(), bucket: bucket(req.url()), reason });
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      badResponses.push({
        url: res.url(),
        bucket: bucket(res.url()),
        status: res.status(),
      });
    }
  });

  console.log(`→ loading ${url} (color-scheme: ${colorScheme})`);
  let navOk = true;
  try {
    // `domcontentloaded` not `networkidle`: a healthy app holds a WS open forever,
    // so networkidle never fires. We settle explicitly below.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    navOk = false;
    console.error(
      `✗ navigation failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Initial settle, then keep watching through the settle window so a
  // mount-then-crash or a delayed 502/404 storm is caught (not just first paint).
  await page.waitForTimeout(waitMs);
  // eslint-disable-next-line promise-safety/no-bare-catch -- a diagnostic screenshot is best-effort; failing to write it must not mask the boot verdict below
  await page.screenshot({ path: `${out}-loaded.png` }).catch(() => {});

  // ── Render assertion: did the SPA actually mount a real tree? ────────────────
  // A black screen / stuck "Starting…" leaves #root empty or near-empty. A real
  // app mounts dozens of nodes. We measure the live DOM under #root.
  const rootStats = await page.evaluate(() => {
    const root = document.getElementById("root");
    if (!root)
      return { present: false, childCount: 0, descendantCount: 0, text: "" };
    return {
      present: true,
      childCount: root.childElementCount,
      descendantCount: root.querySelectorAll("*").length,
      text: (root.innerText || "").trim().slice(0, 200),
    };
  });

  let selectorFound: boolean | null = null;
  if (expectSelector) {
    selectorFound = (await page.locator(expectSelector).count()) > 0;
  }
  let textFound: boolean | null = null;
  if (expectText) {
    textFound = (await page.content()).includes(expectText);
  }

  // Wait out the rest of the settle window to catch late failures, then re-check
  // the render survived (guards against mount-then-unmount crashes).
  const remaining = Math.max(0, settleMs - waitMs);
  if (remaining > 0) await page.waitForTimeout(remaining);
  // eslint-disable-next-line promise-safety/no-absorbed-failure -- 0 IS the verdict here: the point of this probe is "did the tree survive", and an evaluate that fails because the page died mid-settle is exactly the mount-then-crash the `< 10` check below reports as a failure. Throwing would abort the run before the report is printed.
  const survivedDescendants = await page
    .evaluate(
      () => document.getElementById("root")?.querySelectorAll("*").length ?? 0,
    )
    .catch(() => 0);
  // eslint-disable-next-line promise-safety/no-bare-catch -- a diagnostic screenshot is best-effort; failing to write it must not mask the boot verdict below
  await page.screenshot({ path: `${out}-settled.png` }).catch(() => {});

  // ── Verdict ──────────────────────────────────────────────────────────────────
  const failures: string[] = [];
  if (!navOk) failures.push("navigation to the URL failed");
  if (!rootStats.present)
    failures.push("#root element is absent (SPA shell never loaded)");
  // A genuinely-mounted app has many nodes; <10 is a black screen / bare loader.
  if (rootStats.present && rootStats.descendantCount < 10) {
    failures.push(
      `#root mounted only ${rootStats.descendantCount} nodes (childCount=${rootStats.childCount}) — black screen / stuck loader. text=${JSON.stringify(rootStats.text)}`,
    );
  }
  if (survivedDescendants < 10) {
    failures.push(
      `app tree collapsed during the settle window (${survivedDescendants} nodes left) — mount-then-crash`,
    );
  }
  if (expectSelector && !selectorFound) {
    failures.push(`expected selector not found: ${expectSelector}`);
  }
  if (expectText && !textFound) {
    failures.push(`expected text not found: ${JSON.stringify(expectText)}`);
  }
  if (pageErrors.length)
    failures.push(`${pageErrors.length} uncaught page error(s)`);
  if (consoleErrors.length)
    failures.push(`${consoleErrors.length} console error(s)`);

  // Storm detection: count backend failures per bucket (real dial failures, not
  // ERR_ABORTED — a genuine abort the page caused itself, e.g. a navigation
  // cancelling in-flight requests), plus any 5xx / repeated 4xx on /api or /ws.
  const stormCounts: Record<StormBucket, number> = { api: 0, ws: 0, zero: 0 };
  for (const f of requestFailures) {
    if (isStormBucket(f.bucket) && f.reason !== "net::ERR_ABORTED")
      stormCounts[f.bucket]++;
  }
  for (const res of badResponses) {
    if (isStormBucket(res.bucket)) stormCounts[res.bucket]++;
  }
  for (const [b, n] of Object.entries(stormCounts)) {
    if (n >= STORM_THRESHOLD) {
      failures.push(
        `${n} failed ${b} request(s) — gateway↔backend storm on /${b}`,
      );
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log("\n──────── release boot report ────────");
  console.log(`url                : ${url}`);
  console.log(`#root present      : ${rootStats.present}`);
  console.log(
    `#root nodes        : ${rootStats.descendantCount} (children=${rootStats.childCount}) → ${survivedDescendants} after settle`,
  );
  console.log(`#root text (head)  : ${JSON.stringify(rootStats.text)}`);
  if (expectSelector)
    console.log(
      `selector "${expectSelector}": ${selectorFound ? "FOUND" : "MISSING"}`,
    );
  if (expectText)
    console.log(`text "${expectText}"   : ${textFound ? "FOUND" : "MISSING"}`);
  console.log(`console errors     : ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`   • ${e}`);
  console.log(`page errors        : ${pageErrors.length}`);
  for (const e of pageErrors.slice(0, 10)) console.log(`   • ${e}`);
  console.log(
    `request failures   : ${requestFailures.length} (api=${requestFailures.filter((f) => f.bucket === "api").length} ws=${requestFailures.filter((f) => f.bucket === "ws").length})`,
  );
  for (const f of requestFailures.slice(0, 10))
    console.log(`   • [${f.bucket}] ${f.reason} ${f.url}`);
  console.log(`4xx/5xx responses  : ${badResponses.length}`);
  for (const res of badResponses.slice(0, 10))
    console.log(`   • [${res.bucket}] ${res.status} ${res.url}`);
  console.log(`screenshots        : ${out}-loaded.png, ${out}-settled.png`);
  console.log("─────────────────────────────────────");

  const r = report();
  if (failures.length === 0) {
    r.ok("packaged app booted and rendered end-to-end", true);
  } else {
    for (const f of failures) r.fail(f);
  }
  await r.finish();
});
