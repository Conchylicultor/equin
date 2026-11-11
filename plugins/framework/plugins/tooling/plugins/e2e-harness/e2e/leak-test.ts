// Tab memory-leak test: repeat a flow, force GC, diff heap snapshots, verdict.
//
// Usage:
//   ./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/leak-test.ts \
//     --path /agents --clicks "Automations|Tasks" [--iterations 10] [--warmup 2] \
//     [--settle 1000] [--step-wait 300] [--max-kb-per-iter 50] \
//     [--max-detached-per-iter 1] [--max-listeners-per-iter 1] \
//     [--top 15] [--paths 5] [--out "$EQUIN_SCRATCH/leak"] [--attach <ticket>]
//
// The flow is one iteration, repeated:
//   --clicks "A|B|…"   click each control by its exact accessible name, in
//                      order (button, link, tab, menuitem, radio, switch,
//                      treeitem, option), waiting --step-wait ms and for no
//                      visible loader after each. End on the screen you started
//                      from, so every iteration is the same round trip.
//   --idle <ms>        do nothing for <ms>: what a screen leaks just by being
//                      open (live updates, timers).
// A domain flow (seed rows, open a conversation, …) is a script of its own in
// the owning plugin's e2e/ that calls `runLeakTest(page, { step })` from the
// harness barrel with its own step — see the harness CLAUDE.md.
//
// --from <out> re-reads a recorded run (its three snapshots and
// `<out>-run.json`) without a browser — other thresholds, --top, --paths.
//
// Measures warm-up → BASE → run 1 → MID → run 2 → END (each after a forced
// GC), prints what grew over run 2 per constructor, detached DOM nodes, DOM /
// listener counters, the run-1 survivors still alive at END with their
// retainer paths, and a PASS/FAIL verdict (exit 1 on FAIL). The three
// `.heapsnapshot` files load in DevTools → Memory for the full picture.
//
// Pass --no-record for long runs: the run recorder keeps a frame per
// Playwright step.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { arg, numArg, usage } from "./args";
import { pageUrl } from "./target";
import { withBrowser } from "./browser";
import { report } from "./report";
import { waitFor, ELEMENT_TIMEOUT_MS } from "./wait";
import { waitForNetworkIdle } from "./network-idle";
import { waitForNotBusy } from "./busy";
import {
  analyzeLeakRun,
  leakReportText,
  runLeakTest,
  type LeakReport,
  type LeakStep,
} from "./leak";

const from = arg("from");
const clicksRaw = arg("clicks");
const idleMs = arg("idle") === undefined ? undefined : numArg("idle", 0);
const stepWait = numArg("step-wait", 300);
const outArg = arg("out");
const iterations = numArg("iterations", 10);
const warmup = numArg("warmup", 2);
const settleMs = numArg("settle", 1000);
const thresholds = {
  maxBytesPerIteration: numArg("max-kb-per-iter", 50) * 1024,
  maxDetachedPerIteration: numArg("max-detached-per-iter", 1),
  maxListenersPerIteration: numArg("max-listeners-per-iter", 1),
};
const top = numArg("top", 15);
const paths = numArg("paths", 5);

/** Print the report and end the run on its verdict (exit 1 on any FAIL). */
async function conclude(leak: LeakReport): Promise<never> {
  const r = report("leak-test");
  console.log("");
  console.log(leakReportText(leak));
  console.log("");
  for (const c of leak.verdict.checks) r.ok(c.name, c.ok, c.detail);
  return r.finish();
}

// --from: re-read a recorded run, no browser.
if (from !== undefined) {
  if (from === "") usage("leak-test: --from needs the --out prefix of a run.");
  if (clicksRaw !== undefined || idleMs !== undefined)
    usage("leak-test: --from re-reads a recorded run; drop --clicks / --idle.");
  await conclude(analyzeLeakRun(from, { thresholds, top, paths }));
}

if ((clicksRaw === undefined) === (idleMs === undefined))
  usage(
    'leak-test: give the flow — exactly one of --clicks "A|B|…" or --idle <ms>.',
  );
const clicks = (clicksRaw ?? "")
  .split("|")
  .map((s) => s.trim())
  .filter((s) => s !== "");
if (clicksRaw !== undefined && clicks.length === 0)
  usage("leak-test: --clicks names no control.");

const ROLES = [
  "button",
  "link",
  "tab",
  "menuitem",
  "radio",
  "switch",
  "treeitem",
  "option",
] as const;

async function clickable(page: Page, name: string): Promise<Locator> {
  const found = await waitFor(
    async () => {
      for (const role of ROLES) {
        const loc = page.getByRole(role, { name, exact: true });
        if ((await loc.count()) > 0) return loc.first();
      }
      return null;
    },
    (v) => v !== null,
    { timeoutMs: ELEMENT_TIMEOUT_MS, intervalMs: 250 },
  );
  if (!found.value)
    throw new Error(
      `leak-test: no ${ROLES.join("/")} named "${name}" after ${found.waitedMs} ms on ${page.url()}`,
    );
  return found.value;
}

const idleStep =
  (ms: number): LeakStep =>
  async (page) => {
    await page.waitForTimeout(ms);
  };
const step: LeakStep =
  idleMs !== undefined
    ? idleStep(idleMs)
    : async (page) => {
        for (const name of clicks) {
          await (await clickable(page, name)).click();
          await page.waitForTimeout(stepWait);
          const settled = await waitForNotBusy(page, {
            timeoutMs: ELEMENT_TIMEOUT_MS,
          });
          if (!settled.ok)
            throw new Error(
              `leak-test: still loading ${settled.waitedMs} ms after clicking "${name}": ${settled.value.join(" | ")}`,
            );
        }
      };

const url = pageUrl();
const out = outArg ?? join(mkdtempSync(join(tmpdir(), "leak-test-")), "leak");
if (outArg === undefined)
  console.log(
    `out:   ${out}-* (three snapshots of up to hundreds of MB — delete them when done, or pass --out)`,
  );
console.log(`url:   ${url}`);
console.log(
  `flow:  ${clicksRaw !== undefined ? `click ${clicks.map((c) => `"${c}"`).join(" → ")}` : `idle ${idleMs} ms`}`,
);

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdle(page);
  const settled = await waitForNotBusy(page, { timeoutMs: ELEMENT_TIMEOUT_MS });
  if (!settled.ok)
    console.log(`still loading at start: ${settled.value.join(" | ")}`);

  const leak = await runLeakTest(page, {
    step,
    iterations,
    warmup,
    settleMs,
    out,
    thresholds,
    top,
    paths,
  });
  await conclude(leak);
});
