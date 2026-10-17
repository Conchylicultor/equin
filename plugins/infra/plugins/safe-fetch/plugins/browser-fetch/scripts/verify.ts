#!/usr/bin/env bun
// ─── Drive the primitive against a real URL ───────────────────────────────────
//
//   ./singularity run plugins/infra/plugins/safe-fetch/plugins/browser-fetch/scripts/verify.ts <url> [--selector <css>]
//
// This exists because the orchestrator CANNOT be unit-tested against a local
// fixture server: it correctly refuses `localhost`, and adding a test-only SSRF
// bypass flag would put a hole in the one guarantee the plugin sells. So the
// pure halves (`launch-args`, `request-policy`, `errors`) are unit-tested, and
// the wiring between them is proven by hand, here, against three known cases:
//
//   https://shotgun.live/en/venues/paris-erasmus-life
//       expect 200 and ~340 KB. A plain fetch gets 429 + x-vercel-mitigated —
//       so a 200 here is the whole reason the plugin exists.
//   https://desmotsetdesarts.com/
//       expect real event text in the HTML. Proves the cross-origin subresource
//       proxy works: the page's content only appears after its third-party
//       bundle has run.
//   http://169.254.169.254/latest/meta-data/
//       expect SsrfError, thrown before anything is launched.
import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { chromium } from "../deps";
import { browserFetch, BrowserFetchError } from "../server";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
if (url === undefined) {
  console.error("usage: verify.ts <url> [--selector <css>]");
  process.exit(2);
}
const selectorIdx = args.indexOf("--selector");
const waitForSelector = selectorIdx >= 0 ? args[selectorIdx + 1] : undefined;

// A script is not a backend: install Chromium here (a `deps install` child,
// progress on this terminal) rather than meet `browserFetch`'s request-path
// answer, which is to enqueue a job no backend of this script's runs.
await ensureDepViaCli(chromium, { stdio: "inherit", grant: null });

try {
  const res = await browserFetch(url, { waitForSelector });
  const bytes = Buffer.byteLength(res.html, "utf8");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(res.html)?.[1]?.trim();

  console.log(`url        ${res.url}`);
  console.log(`status     ${res.status}`);
  console.log(`redirects  ${res.redirects}`);
  console.log(`html       ${bytes} bytes`);
  console.log(`title      ${title ?? "(none)"}`);
  console.log(
    `timings    launch ${Math.round(res.timings.launchMs)}ms · ` +
      `navigate ${Math.round(res.timings.navigateMs)}ms · ` +
      `settle ${Math.round(res.timings.settleMs)}ms · ` +
      `total ${Math.round(res.timings.totalMs)}ms`,
  );
  const interesting = [
    "content-type",
    "server",
    "x-vercel-mitigated",
    "cf-ray",
  ];
  for (const name of interesting) {
    const value = res.headers[name];
    if (value !== undefined) console.log(`header     ${name}: ${value}`);
  }
} catch (err) {
  // Print the classification, not just the message — which bucket an error lands
  // in is the part consumers depend on.
  if (err instanceof BrowserFetchError) {
    console.error(`FAILED [${err.name}/${err.kind}] ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`FAILED [${err.name}] ${err.message}`);
  } else {
    console.error(`FAILED ${String(err)}`);
  }
  process.exit(1);
}

// Chromium is closed, but the host-pool flock fds and the profiler's timers keep
// the loop alive; this script's job is done the moment the result is printed.
process.exit(0);
