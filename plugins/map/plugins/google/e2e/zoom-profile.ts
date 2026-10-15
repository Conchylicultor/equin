// Profiles wheel-zooming the Places map on THIS checkout's deploy: wheels in
// and back out in steps over the map's centre, and reports where the time went
// — frame times (rAF gaps), Chrome's script / style / layout totals, the CPU
// profile's hottest functions and the overlay DOM churn (pin overlays added and
// removed, which source the mutations come from). Needs saved places with a
// location. The host is noisy: compare RecalcStyleDuration over several runs.
//
// Usage:
//   ./singularity run plugins/map/plugins/google/e2e/zoom-profile.ts \
//     [--steps 6] [--out /tmp/map-zoom-profile] [--trace] [--strip-has=<regex>]
//
// --trace          also writes `<out>-trace.json` with style-invalidation
//                  tracking: which selectors invalidate which nodes and why.
// --strip-has=<re> deletes, before zooming, every `:has()` rule whose selector
//                  matches <re> (nested rules included) — the counterfactual
//                  for "is this rule what makes DOM churn expensive?".
//
// Writes `<out>-profile.cpuprofile` (open it in Chrome DevTools → Performance).

import { writeFileSync } from "node:fs";
import {
  arg,
  flag,
  numArg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/map-zoom-profile");
const steps = numArg("steps", 6);

declare global {
  interface Window {
    __zoomProbe?: {
      frames: number[];
      added: number;
      removed: number;
      running: boolean;
      ops: Record<string, number>;
    };
  }
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface CpuProfile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  await page
    .getByRole("button", { name: "Add place", exact: true })
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(4000);

  const map = page.locator(".gm-style").first();
  const box = await map.boundingBox();
  if (box === null) throw new Error("no map on /places");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  const overlays = () =>
    page.evaluate(
      () =>
        document.querySelectorAll('.gm-style [role="button"][aria-label]')
          .length,
    );

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });

  const metrics = async () => {
    const { metrics: list } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
  };

  // Frame gaps and overlay churn, recorded in the page.
  await page.evaluate(() => {
    const probe = {
      frames: [] as number[],
      added: 0,
      removed: 0,
      running: true,
      ops: {} as Record<string, number>,
    };
    window.__zoomProbe = probe;
    let last = performance.now();
    const tick = (t: number) => {
      probe.frames.push(t - last);
      last = t;
      if (probe.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const root = document.querySelector(".gm-style");
    if (root === null) throw new Error("no .gm-style");
    new MutationObserver((records) => {
      const pin = '[role="button"][aria-label]';
      const ours = (n: Node, target: Node) =>
        (target instanceof Element && target.closest(pin) !== null) ||
        (n instanceof Element &&
          (n.matches(pin) || n.querySelector(pin) !== null));
      for (const r of records) {
        probe.added += r.addedNodes.length;
        probe.removed += r.removedNodes.length;
        for (const n of [...r.addedNodes, ...r.removedNodes]) {
          const key = ours(n, r.target)
            ? "pins"
            : `google ${n.nodeName}${n instanceof Element && n.parentElement === null && r.target instanceof Element ? ` in ${r.target.nodeName}` : ""}`;
          probe.ops[key] = (probe.ops[key] ?? 0) + 1;
        }
      }
    }).observe(root, { childList: true, subtree: true });
  });

  console.log(`overlays at start: ${await overlays()}`);
  const census = await page.evaluate(() => ({
    nodes: document.getElementsByTagName("*").length,
    underMap: document.querySelectorAll(".gm-style *").length,
  }));
  console.log(
    `DOM: ${census.nodes} elements (${census.underMap} under the map)`,
  );
  if (flag("strip-has")) {
    const stripped = await page.evaluate(
      (only) => {
        const hit: string[] = [];
        const walk = (owner: CSSStyleSheet | CSSGroupingRule) => {
          const list = owner.cssRules;
          for (let i = list.length - 1; i >= 0; i--) {
            const r = list[i];
            if (r === undefined) continue;
            if (
              r instanceof CSSStyleRule &&
              r.selectorText.includes(":has(") &&
              new RegExp(only).test(r.selectorText)
            ) {
              owner.deleteRule(i);
              hit.push(r.selectorText);
            } else if ("cssRules" in r) walk(r as CSSGroupingRule);
          }
        };
        for (const sh of document.styleSheets) {
          try {
            walk(sh);
          } catch (err) {
            if (!(err instanceof DOMException)) throw err;
          }
        }
        return hit;
      },
      arg("strip-has", ""),
    );
    console.log(stripped.join("\n"));
    console.log(
      `stripped ${stripped.length} :has() rules matching "${arg("strip-has", "")}"`,
    );
  }
  const tracing = flag("trace");
  const browser = page.context().browser();
  if (tracing) {
    if (browser === null) throw new Error("no browser to trace");
    await browser.startTracing(page, {
      path: `${out}-trace.json`,
      categories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.invalidationTracking",
      ],
    });
  }
  const before = await metrics();
  await cdp.send("Profiler.start");

  await page.mouse.move(centre.x, centre.y);
  const perStep: string[] = [];
  for (const dir of [-1, 1] as const) {
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, dir * 120);
      await page.waitForTimeout(700);
      perStep.push(`${dir < 0 ? "in " : "out"} ${i + 1}: ${await overlays()}`);
    }
  }

  const { profile } = (await cdp.send("Profiler.stop")) as {
    profile: CpuProfile;
  };
  const after = await metrics();
  if (tracing && browser !== null) await browser.stopTracing();
  const probe = await page.evaluate(() => {
    const p = window.__zoomProbe;
    if (p === undefined) throw new Error("probe missing");
    p.running = false;
    return p;
  });

  console.log(`overlays per step: ${perStep.join(" | ")}`);
  const frames = probe.frames.slice(1).sort((a, b) => a - b);
  const pct = (q: number) =>
    frames[Math.min(frames.length - 1, Math.floor(q * frames.length))] ?? 0;
  const jank = frames.filter((f) => f > 50);
  console.log(
    `frames ${frames.length}: p50 ${pct(0.5).toFixed(1)}ms p90 ${pct(0.9).toFixed(1)}ms p99 ${pct(0.99).toFixed(1)}ms max ${pct(1).toFixed(1)}ms; >50ms: ${jank.length} (sum ${jank.reduce((s, f) => s + f, 0).toFixed(0)}ms)`,
  );
  console.log(
    `overlay DOM churn: +${probe.added} / -${probe.removed} nodes under .gm-style`,
  );
  console.log(
    `mutation ops by source: ${JSON.stringify(
      Object.entries(probe.ops)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
    )}`,
  );
  for (const k of [
    "TaskDuration",
    "ScriptDuration",
    "RecalcStyleDuration",
    "LayoutDuration",
    "RecalcStyleCount",
    "LayoutCount",
    "Nodes",
  ]) {
    const a = after[k] ?? 0;
    const b = before[k] ?? 0;
    const delta = k.endsWith("Duration")
      ? `${((a - b) * 1000).toFixed(0)}ms`
      : `${a - b}`;
    console.log(`  ${k}: ${delta}`);
  }

  // Self time per function, from the samples.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  const byOrigin = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    if (n === undefined) return;
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    const { functionName, url, lineNumber } = n.callFrame;
    const file = url.split("/").pop() ?? "";
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    const origin =
      url.includes("googleapis") || url.includes("gstatic")
        ? "google maps"
        : url === ""
          ? functionName || "(native)"
          : "app";
    byOrigin.set(origin, (byOrigin.get(origin) ?? 0) + dt);
  });
  const top = (m: Map<string, number>, n: number) =>
    [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log("self time by origin:");
  for (const [k, v] of top(byOrigin, 8))
    console.log(`  ${v.toFixed(0)}ms ${k}`);
  console.log("top self-time functions:");
  for (const [k, v] of top(self, 30)) console.log(`  ${v.toFixed(0)}ms ${k}`);

  writeFileSync(`${out}-profile.cpuprofile`, JSON.stringify(profile));
  console.log(`wrote ${out}-profile.cpuprofile`);
});
