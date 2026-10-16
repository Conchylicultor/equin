// How long /places takes to draw its map on THIS checkout's deploy, and where
// the main thread spends that time: navigates with a CPU profile running,
// times navigation → first pin and → the place card after a pin click, counts
// the overlays drawn, and prints the heaviest functions by self time.
//
// Usage:
//   ./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/load-perf.ts \
//     [--out /tmp/places-perf] [--top 15] [--idle 30000]
//
// Four phases, each CPU-profiled: load (navigation → first pin), idle (--idle
// ms untouched, while background writes such as the icon jobs land), zoom
// (click the biggest cluster), card (click a drop). Writes
// `<out>-<phase>.cpuprofile` (open in Chrome DevTools → Performance) and
// `<out>-loaded.png` / `<out>-zoomed.png` / `<out>-card.png`.

import {
  arg,
  numArg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  clickPin,
  listedPins,
  pinsOnScreen,
  reachablePins,
} from "@plugins/map/e2e";
import { writeFileSync } from "node:fs";

const out = arg("out", "/tmp/places-perf");
const top = numArg("top", 15);
const idleMs = numArg("idle", 30_000);

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
}
interface Profile {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
  startTime: number;
  endTime: number;
}

/** Self time per function (ms), heaviest first. */
function selfTimes(profile: Profile): { name: string; ms: number }[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const ms = new Map<string, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]!);
    if (node === undefined) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    const file = url.split("/").pop() ?? url;
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber + 1}`;
    ms.set(key, (ms.get(key) ?? 0) + (deltas[i] ?? 0) / 1000);
  }
  return [...ms.entries()]
    .map(([name, v]) => ({ name, ms: v }))
    .sort((a, b) => b.ms - a.ms);
}

/** The longest run of consecutive non-idle samples (ms): the worst freeze. */
function longestBusy(profile: Profile): number {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let longest = 0;
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    const idle = byId.get(samples[i]!)?.callFrame.functionName === "(idle)";
    run = idle ? 0 : run + (deltas[i] ?? 0) / 1000;
    longest = Math.max(longest, run);
  }
  return longest;
}

function printHeaviest(profile: Profile): void {
  const busy = selfTimes(profile).filter(
    (e) => !e.name.startsWith("(idle)") && !e.name.startsWith("(program)"),
  );
  const total = busy.reduce((sum, e) => sum + e.ms, 0);
  console.log(
    `  main-thread JS ${Math.round(total)} ms; longest busy stretch ${Math.round(longestBusy(profile))} ms; heaviest:`,
  );
  for (const e of busy.slice(0, top)) {
    console.log(`    ${e.ms.toFixed(0).padStart(6)} ms  ${e.name}`);
  }
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  const stop = async (phase: string): Promise<void> => {
    const { profile } = (await cdp.send("Profiler.stop")) as {
      profile: Profile;
    };
    writeFileSync(`${out}-${phase}.cpuprofile`, JSON.stringify(profile));
    printHeaviest(profile);
  };
  const overlays = listedPins(page);

  // Phase 1 — load: navigation → the chrome → the first pin.
  await cdp.send("Profiler.start");
  const t0 = Date.now();
  await page.goto(pathUrl("/places"), { waitUntil: "commit" });
  await page
    .getByRole("button", { name: "Add place", exact: true })
    .waitFor({ timeout: 120_000 });
  const tChrome = Date.now() - t0;
  await overlays.first().waitFor({ state: "attached", timeout: 120_000 });
  const tPin = Date.now() - t0;
  // Where the time went, as the app marks it (perfs/boot-trace): the generic
  // boot (module eval → eager plugins → the route's content), then the map
  // (its renderer read → its first pin drawn).
  const marks = await page.evaluate(() =>
    performance
      .getEntriesByType("mark")
      .filter((m) =>
        /^boot:(module-eval|set-state|route-content-commit)$|^slot-read:map\.(renderer|pin)$/.test(
          m.name,
        ),
      )
      .map((m) => `${m.name}@${Math.round(m.startTime)}`),
  );
  console.log(`[load] chrome (Add place) at ${tChrome} ms`);
  console.log(`[load] first pin at       ${tPin} ms`);
  console.log(`[load] boot marks         ${marks.join(", ") || "(none)"}`);
  await stop("load");

  // Phase 2 — idle: nothing touched while the icon jobs land.
  await cdp.send("Profiler.start");
  await page.waitForTimeout(idleMs);
  console.log(`[idle ${idleMs} ms] overlays on map ${await overlays.count()}`);
  await stop("idle");
  await snap(page, out, "loaded");

  // Phase 3 — zoom: click the biggest cluster (its pins framed), let it settle.
  let biggest: string | null = null;
  let bestN = 0;
  for (const { label } of await pinsOnScreen(page)) {
    const n = Number(/^(\d+) pins/.exec(label)?.[1] ?? 0);
    if (n > bestN) {
      bestN = n;
      biggest = label;
    }
  }
  if (biggest !== null) {
    await cdp.send("Profiler.start");
    const t1 = Date.now();
    await clickPin(page, biggest);
    await page.waitForTimeout(3000);
    console.log(
      `[zoom] ${Date.now() - t1} ms incl. 3 s settle; overlays ${await overlays.count()}`,
    );
    await stop("zoom");
    await snap(page, out, "zoomed");
  }

  // Phase 4 — a saved-place drop (not a cluster) opens its card.
  const [drop] = await reachablePins(page);
  if (drop === undefined) throw new Error("no saved-place drop on screen");
  await cdp.send("Profiler.start");
  const t2 = Date.now();
  await clickPin(page, drop.label);
  await page
    .getByRole("button", { name: "Close", exact: true })
    .waitFor({ timeout: 60_000 });
  console.log(`[card] pin click → card ${Date.now() - t2} ms`);
  await stop("card");
  await page.waitForTimeout(1000);
  await snap(page, out, "card");
});
