/**
 * How long the demo takes to come up, first visit and warm reload, split by
 * stage. In `/demo` at the Agent Manager, in one fresh browser context (so its
 * IndexedDB and HTTP cache start empty), it opens the demo once (a first
 * visit: the snapshot is loaded) and then reloads it `--reloads` times (warm:
 * same build, data already stored, assets in the HTTP cache). For each load it
 * prints one line:
 *
 *  - `page`: navigation start → the page's DOMContentLoaded (the page bundle);
 *  - `host`: the page asking for the host module → the worker's `ready`, as
 *    DemoScope's boot line reports it, with the worker's own stages (the
 *    worker's clock starts when it is created) — `data:` says where its data
 *    came from;
 *  - `paint`: navigation start → the Agent Manager's conversation shown;
 *  - `page boot`: the page's own boot spans (`boot-trace`), at least 20 ms.
 *
 * It also says whether the worker survived the reload (a reload whose worker
 * was already running reports a `readyAtMs` older than the page).
 *
 * Asserts nothing about the numbers (they depend on the machine); it fails
 * only when the demo does not come up.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/reload-timing.ts [--reloads 3]
 */
import type { Page } from "playwright";
import {
  numArg,
  pathUrl,
  report,
  waitFor,
  withBrowser,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  AGENT_MANAGER_LOCATION,
  demoPath,
  MARKER,
  RENDER_TIMEOUT_MS,
  bootDemo,
} from "./internal/demo-pages";

const RELOADS = numArg("reloads", 3);

interface LoadTiming {
  dclMs: number;
  paintMs: number;
  bootLine: string | null;
  /** The page's own boot spans (`boot-trace`'s `boot:*` User Timing entries). */
  bootTrace: string;
}

/** Load the demo in `page` (`load` navigates or reloads) and time it. */
async function timeLoad(
  r: Report,
  page: Page,
  step: string,
  load: () => Promise<unknown>,
): Promise<LoadTiming> {
  const lines: string[] = [];
  const onConsole = (m: { text(): string }) => {
    if (m.text().startsWith("[demo-scope]")) lines.push(m.text());
  };
  page.on("console", onConsole);
  await load();
  await page
    .locator(MARKER)
    .first()
    .waitFor({ state: "visible", timeout: RENDER_TIMEOUT_MS });
  const paintMs = await page.evaluate(() => performance.now());
  const settled = await waitFor(
    async () => lines.at(-1) ?? null,
    (line) => line !== null,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  page.off("console", onConsole);
  r.ok(`${step}: the host reported its boot`, settled.ok, settled.value ?? "");
  const dclMs = await page.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming;
    return nav.domContentLoadedEventEnd;
  });
  const bootTrace = await page.evaluate(() =>
    performance
      .getEntries()
      .filter(
        (e) =>
          (e.entryType === "mark" || e.entryType === "measure") &&
          e.name.startsWith("boot:") &&
          (e.entryType === "mark" || e.duration >= 20),
      )
      .sort((a, b) => a.startTime - b.startTime)
      .map(
        (e) =>
          `${e.name.slice("boot:".length)} @${Math.round(e.startTime)}${e.entryType === "measure" ? `+${Math.round(e.duration)}` : ""}`,
      )
      .join(", "),
  );
  // When the head script's own modules arrived (`apps/demo/shell`'s prestart).
  const prestartModules = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) =>
        /demo\.prestart\.web|\.browser-host\.[0-9a-f]+\/host\.js/.test(e.name),
      )
      .map(
        (e) =>
          `${e.name.replace(/^.*\/artifacts\//, "")} ${Math.round(e.startTime)}→${Math.round((e as PerformanceResourceTiming).responseEnd)}`,
      )
      .join(", "),
  );
  return {
    dclMs,
    paintMs,
    bootLine: settled.value,
    bootTrace: `${bootTrace}\n  head-script modules: ${prestartModules}`,
  };
}

/** The page-clock instants the boot line carries: when the host was asked for, and when it was ready. */
function hostInstants(
  line: string | null,
): { asked: number; ready: number } | null {
  const m =
    line === null
      ? null
      : /host ready in (\d+) ms, asked at (\d+) ms/.exec(line);
  if (m === null) return null;
  const asked = Number(m[2]);
  return { asked, ready: asked + Number(m[1]) };
}

function describe(step: string, t: LoadTiming): string {
  const line = t.bootLine?.replace(/^\[demo-scope\] /, "") ?? "no boot line";
  const at = hostInstants(t.bootLine);
  const split =
    at === null
      ? ""
      : `, host asked at ${at.asked} ms, ready at ${at.ready} ms, ready → paint ${Math.round(t.paintMs - at.ready)} ms`;
  return `${step}: page ${Math.round(t.dclMs)} ms${split}, paint ${Math.round(t.paintMs)} ms\n  ${line}\n  page boot: ${t.bootTrace}`;
}

await withBrowser(async (h) => {
  const r = report("demo: first visit and warm reload, by stage");
  const { page } = await h.session();
  // The page loads ~1,600 modules: Resource Timing's default 250-entry buffer
  // would drop the entries this script reads.
  await page.addInitScript(() =>
    performance.setResourceTimingBufferSize(10_000),
  );
  const url = pathUrl(demoPath(AGENT_MANAGER_LOCATION));

  const first = await timeLoad(r, page, "first visit", () =>
    bootDemo(page, url, { marker: MARKER, timeoutMs: RENDER_TIMEOUT_MS }),
  );
  console.info(describe("first visit", first));
  for (let i = 1; i <= RELOADS; i++) {
    const t = await timeLoad(r, page, `reload ${i}`, () =>
      page.reload({ waitUntil: "domcontentloaded" }),
    );
    console.info(describe(`reload ${i}`, t));
  }
  await r.finish();
});
