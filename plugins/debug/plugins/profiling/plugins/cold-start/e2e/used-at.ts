// What a page really USED of its upfront code: one cold load under V8
// precise coverage, read at one moment — the route-content mark
// (`boot:route-content-commit`, the first screen with data) or first
// contentful paint — and split into the source modules the scripts that had
// arrived by then hold, the ones whose init ran, and the ones with another
// function called.
//
//   ./equin run plugins/debug/plugins/profiling/plugins/cold-start/e2e/used-at.ts \
//     [--url http://equin.localhost:<port>] [--path /agents] [--at content|fcp] [--dump <file.json>]
//
// Fresh browser context (empty HTTP cache), desktop viewport, no network
// shaping or CPU throttling: the set of scripts that land before the moment
// can vary a little between runs (a faster run lands more), so run it a few
// times and quote the range. `--dump` writes `{ url, at, called, initialised,
// held }`, each a list of `{ src, wire, npm }` (source-map path, estimated
// wire bytes, whether it is an npm module) — the input
// `codegen/scripts/measure-predicted-set.ts --website-used / --main-used`
// compares its predicted set against.
//
// Method and limits (the same as website/landing/screenshot's home-load
// `--coverage`, which measures the phone case):
// - The upfront set is every Script request that finished before the moment.
// - A module's wire bytes are its share of its script's generated characters
//   times the script's encoded size (CDP `encodedDataLength`, headers
//   included) — an estimate.
// - "Called" means a function of the module other than its `__esmMin` init
//   ran. That includes calls made while REGISTERING a plugin (a helper its
//   definition calls at module init), so a plugin loaded only because it is
//   upfront today shows as used: "called" is an upper bound on what the
//   screen needs, not a floor for a smaller upfront set.
// - A module whose only code is top-level statements counts as initialised,
//   never as called. npm code is not wrapped per module: for it initialised
//   and called are the same.
// - Coverage slows the page; the moment's time is printed but is not a timing.

import type { CDPSession } from "playwright";
import {
  arg,
  isNpmSource,
  modulesOf,
  pageUrl,
  ranModules,
  readScriptMaps,
  startCoverage,
  takeCoverage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  BOOT_TIMING_PREFIX,
  ROUTE_CONTENT_COMMIT_ID,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";

const AT = arg("at") ?? "content";
if (AT !== "content" && AT !== "fcp")
  throw new Error(`--at ${AT}: one of content, fcp`);
const DUMP = arg("dump");
const url = pageUrl("/agents");
const MARK =
  AT === "content"
    ? `${BOOT_TIMING_PREFIX}${ROUTE_CONTENT_COMMIT_ID}`
    : "first-contentful-paint";

interface Req {
  url: string;
  type: string;
  done: number | null;
  bytes: number;
  failed: boolean;
}

/** Every request of the page, with when it finished and its encoded size. */
function tapNetwork(cdp: CDPSession): {
  reqs: Map<string, Req>;
  navStart: () => number;
} {
  const reqs = new Map<string, Req>();
  let nav: number | null = null;
  cdp.on("Network.requestWillBeSent", (e) => {
    if (nav === null && e.type === "Document") nav = e.timestamp;
    reqs.set(e.requestId, {
      url: e.request.url,
      type: e.type ?? "Other",
      done: null,
      bytes: 0,
      failed: false,
    });
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (r === undefined) return;
    r.done = e.timestamp;
    r.bytes = e.encodedDataLength;
  });
  cdp.on("Network.loadingFailed", (e) => {
    const r = reqs.get(e.requestId);
    if (r === undefined) return;
    r.done = e.timestamp;
    r.failed = true;
  });
  return {
    reqs,
    navStart: () => {
      if (nav === null) throw new Error("no Document request seen");
      return nav;
    },
  };
}

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;

await withBrowser(async (h) => {
  const context = await h.browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const net = tapNetwork(cdp);
  await startCoverage(cdp);
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForFunction(
    (n) => performance.getEntriesByName(n).length > 0,
    MARK,
    { polling: "raf", timeout: 120_000 },
  );
  const coverage = await takeCoverage(cdp);
  const atMs = await page.evaluate(
    (n) => performance.getEntriesByName(n)[0]?.startTime ?? Number.NaN,
    MARK,
  );
  const nav0 = net.navStart();
  const upfront = [...net.reqs.values()].filter(
    (q) =>
      q.type === "Script" &&
      !q.failed &&
      q.done !== null &&
      (q.done - nav0) * 1000 <= atMs,
  );
  await context.close();

  // The source maps, over a fresh context of the same origin.
  const reader = await h.browser.newContext();
  const readerPage = await reader.newPage();
  await readerPage.goto(new URL("/robots.txt", url).href);
  const maps = await readScriptMaps(
    readerPage,
    upfront.map((q) => q.url),
  );
  await reader.close();

  const wireOf = new Map(upfront.map((q) => [q.url, q.bytes]));
  const modules = new Map<string, { chars: number; wire: number }>();
  for (const map of maps.values()) {
    const wire = wireOf.get(map.href) ?? 0;
    for (const [src, { chars }] of modulesOf([map])) {
      const e = modules.get(src) ?? { chars: 0, wire: 0 };
      e.chars += chars;
      e.wire += map.text.length === 0 ? 0 : (wire * chars) / map.text.length;
      modules.set(src, e);
    }
  }
  const { initialised, called } = ranModules(coverage, maps);
  const rows = (names: Iterable<string>) =>
    [...names].flatMap((src) => {
      const m = modules.get(src);
      return m === undefined
        ? []
        : [{ src, wire: m.wire, npm: isNpmSource(src) }];
    });
  const sum = (names: Iterable<string>): string => {
    const r = rows(names);
    const ours = r.filter((x) => !x.npm);
    const wire = r.reduce((t, x) => t + x.wire, 0);
    const oursWire = ours.reduce((t, x) => t + x.wire, 0);
    return (
      `${r.length} modules (${ours.length} ours, ${r.length - ours.length} npm), ` +
      `~${kb(wire)} wire (ours ~${kb(oursWire)}, npm ~${kb(wire - oursWire)})`
    );
  };
  const total = upfront.reduce((t, q) => t + q.bytes, 0);
  console.log(
    `${url}: at ${AT} (${Math.round(atMs)} ms, coverage on: not a timing)`,
  );
  console.log(
    `  upfront:     ${upfront.length} scripts, ${kb(total)} wire, ${maps.size} with a source map`,
  );
  console.log(`  held:        ${sum(modules.keys())}`);
  console.log(`  initialised: ${sum(initialised)}`);
  console.log(`  called:      ${sum(called)}`);
  if (DUMP !== undefined) {
    await Bun.write(
      DUMP,
      JSON.stringify({
        url,
        at: AT,
        called: rows(called),
        initialised: rows(initialised),
        held: rows(modules.keys()),
      }),
    );
    console.log(`  wrote ${DUMP}`);
  }
});
