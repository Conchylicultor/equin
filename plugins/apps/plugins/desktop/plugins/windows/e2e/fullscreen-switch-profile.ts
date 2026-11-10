// Profiles the desktop's Full screen round trip on THIS checkout's deploy:
// opens an app in a desktop window, clicks the window's Full screen control
// (the grow, then the switch to the solo placement) and picks Desktop in the
// action bar's Layout control (the switch back), and for each direction reports where the main
// thread went — Chrome's script / style / layout totals (CPU, not wall: a
// throttled Chromium waits to be scheduled), the wall time from the gesture
// to the tab container's new frame, and the CPU profile's self time by
// function and by source file (each plugin's web code is its own artifact,
// so the file names the plugin).
//
// It also logs the <style> elements each switch adds and removes (id, size,
// selector head), so a theme-scope swap shows up by name.
//
// Usage:
//   ./equin run plugins/apps/plugins/desktop/plugins/windows/e2e/fullscreen-switch-profile.ts \
//     [--path /desktop/sonata] [--rounds 3] [--top 25] [--out <prefix>] \
//     [--windows 3] [--init counterfactual.js] [--invalidations] \
//     [--settle 1500] [--quiet]
//
// --windows: further windows of the app to open (Alt+N, the desktop's new
//   window) before the round trips — solo hides them, so exit restyles them.
// --init: a script added to the page before boot (page.addInitScript) — a
//   counterfactual, e.g. one dropping every write of a custom property on
//   <html> after the first, to measure what that invalidation costs.
// --invalidations: also trace Chrome's style-invalidation tracking and list
//   what scheduled the invalidations (node, changed class / attribute / sheet)
//   — what made a recalc whole-document. Slows the switch; ignore its times.
// --settle: how long after the frame flip still counts as the switch (ms) —
//   long enough for what the switch sets off late (a remeasure, a transition).
// --quiet: totals and style mutations only, no CPU profile breakdown.
//
// With --out, writes `<out>-<direction>-<round>.cpuprofile` (open it in
// Chrome DevTools → Performance).

import { readFileSync, writeFileSync } from "node:fs";
import {
  arg,
  flag,
  numArg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openFloatingActionBar } from "@plugins/shell/plugins/global-action-bar/e2e";
import { readDarwinBackground } from "@plugins/packages/plugins/spawn-priority/core";

const path = arg("path", "/desktop/sonata");
const rounds = numArg("rounds", 3);
const top = numArg("top", 25);
const out = arg("out");
const windows = numArg("windows", 0);
const init = arg("init");
const quiet = flag("quiet");
const invalidations = flag("invalidations");
const settle = numArg("settle", 1500);
console.log(`scheduling tier: ${readDarwinBackground().kind}`);

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

/** A trace event, as far as the style-recalc tally reads one. */
interface TraceEvent {
  name: string;
  ph: string;
  dur?: number;
  tdur?: number;
  args?: {
    elementCount?: number;
    data?: { elementCount?: number } & Record<string, unknown>;
  };
}

/** One <style> element a switch added or removed. */
interface StyleChange {
  op: "+" | "-" | "~";
  id: string;
  chars: number;
  head: string;
}

/** The probe parked on the page: when the tab containers' frames flipped. */
type ProbeWindow = Window & {
  __fsProbe?: {
    t0: number;
    flippedAt: number | null;
    styles: StyleChange[];
    root: string[];
  };
};

/** A recalc restyling at least this many elements is a whole-document one. */
const BIG_RECALC = 5000;

const METRICS = [
  "TaskDuration",
  "ScriptDuration",
  "RecalcStyleDuration",
  "LayoutDuration",
  "RecalcStyleCount",
  "LayoutCount",
  "Nodes",
] as const;

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  if (init !== undefined) await page.addInitScript(readFileSync(init, "utf8"));
  await page.goto(pathUrl(path));
  const fullscreen = page.getByRole("button", { name: "Full screen" }).first();
  await fullscreen.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  for (let i = 0; i < windows; i++) {
    await page.keyboard.press("Alt+n");
    await page.waitForTimeout(3000);
  }
  const tabs = await page.locator("[data-tab-id]").count();
  const nodes = await page.evaluate(
    () => document.getElementsByTagName("*").length,
  );
  console.log(`tab containers: ${tabs}, elements: ${nodes}`);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  const metrics = async () => {
    const { metrics: list } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
  };

  /**
   * Arm the probe: record when a tab container's frame flips (its `position`
   * changes from what it was when armed: into `fixed` for solo, out of it
   * back on the desktop) — checked once a frame, after the commit (reading it
   * inside a mutation callback would force a style recalc mid-commit and bill
   * it to the switch); and log the <style> elements added, removed and
   * rewritten in place meanwhile.
   */
  const arm = () =>
    page.evaluate((settleMs) => {
      const tabs = () => [
        ...document.querySelectorAll<HTMLElement>("[data-tab-id]"),
      ];
      const position = (el: HTMLElement) => getComputedStyle(el).position;
      // By tab id: the switch may remount a tab's container.
      const armed = new Map(
        tabs().map((el) => [el.dataset.tabId, position(el)]),
      );
      const probe = {
        t0: performance.now(),
        flippedAt: null as number | null,
        styles: [] as StyleChange[],
        root: [] as string[],
      };
      (window as ProbeWindow).__fsProbe = probe;
      const describe = (op: "+" | "-" | "~", el: Node) => {
        if (!(el instanceof HTMLStyleElement)) return;
        const text = el.textContent ?? "";
        probe.styles.push({
          op,
          id: el.id || "(no id)",
          chars: text.length,
          head: text.slice(0, 80).replace(/\s+/g, " "),
        });
      };
      const mo = new MutationObserver((records) => {
        const rewritten = new Set<Node>();
        for (const r of records) {
          if (r.target === document.head) {
            r.addedNodes.forEach((n) => describe("+", n));
            r.removedNodes.forEach((n) => describe("-", n));
          } else {
            const style =
              r.target instanceof HTMLStyleElement
                ? r.target
                : r.target.parentNode;
            if (style !== null) rewritten.add(style);
          }
        }
        rewritten.forEach((n) => describe("~", n));
      });
      // Every write to <html>'s attributes: a custom property or class there
      // invalidates the style of every element under it.
      const html = document.documentElement;
      const rootMo = new MutationObserver((records) => {
        for (const r of records) {
          const name = r.attributeName ?? "";
          probe.root.push(
            `${name}: ${r.oldValue ?? "(none)"} → ${html.getAttribute(name) ?? "(none)"}`,
          );
        }
      });
      rootMo.observe(html, { attributes: true, attributeOldValue: true });
      mo.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      const check = () => {
        const flipped = tabs().some(
          (el) =>
            armed.has(el.dataset.tabId) &&
            position(el) !== armed.get(el.dataset.tabId),
        );
        if (flipped) {
          probe.flippedAt = performance.now() - probe.t0;
          // Leave the style log open through the settle window.
          setTimeout(() => {
            mo.disconnect();
            rootMo.disconnect();
          }, settleMs - 100);
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    }, settle);

  /** Each direction's per-round metric deltas, for the medians at the end. */
  const deltas: Record<string, Record<string, number[]>> = {};

  const measure = async (
    label: string,
    round: number,
    gesture: () => Promise<void>,
  ) => {
    await arm();
    const browser = page.context().browser();
    if (browser === null) throw new Error("no browser to trace");
    await browser.startTracing(page, {
      categories: [
        "devtools.timeline",
        ...(invalidations
          ? ["disabled-by-default-devtools.timeline.invalidationTracking"]
          : []),
      ],
    });
    const before = await metrics();
    await cdp.send("Profiler.start");
    await gesture();
    await page.waitForFunction(
      () => (window as ProbeWindow).__fsProbe?.flippedAt != null,
      undefined,
      { timeout: 30_000 },
    );
    // Let the frame after the switch (and any effect cascade) finish.
    await page.waitForTimeout(settle);
    const { profile } = (await cdp.send("Profiler.stop")) as {
      profile: CpuProfile;
    };
    const after = await metrics();
    const trace = await browser.stopTracing();
    const recalcs = styleRecalcs(trace);
    const probe = await page.evaluate(() => (window as ProbeWindow).__fsProbe);
    const flippedAt = probe?.flippedAt ?? null;
    console.log(
      `\n=== ${label} #${round}: gesture → frame flip in ${flippedAt?.toFixed(0)}ms wall`,
    );
    for (const k of METRICS) {
      const d = (after[k] ?? 0) - (before[k] ?? 0);
      ((deltas[label] ??= {})[k] ??= []).push(d);
      console.log(
        `  ${k}: ${k.endsWith("Duration") ? `${(d * 1000).toFixed(0)}ms` : d}`,
      );
    }
    // The work itself, not its time: elements restyled per recalc does not
    // drift with how busy the host is.
    const styled = recalcs.reduce((n, r) => n + r, 0);
    const big = recalcs.filter((r) => r >= BIG_RECALC);
    console.log(
      `  styled elements: ${styled} in ${recalcs.length} recalcs; ` +
        `${big.length} over ${BIG_RECALC} elements (${big.join(", ")})`,
    );
    ((deltas[label] ??= {}).StyledElements ??= []).push(styled);
    ((deltas[label] ??= {}).BigRecalcs ??= []).push(big.length);
    if (invalidations) invalidationReport(trace);
    const styles = probe?.styles ?? [];
    const tally = (op: StyleChange["op"]) => {
      const of = styles.filter((c) => c.op === op);
      return `${op}${of.length} (${of.reduce((n, c) => n + c.chars, 0)} chars)`;
    };
    console.log(`  <style> ${tally("+")} ${tally("-")} ${tally("~")}`);
    const rootStyle = await page.evaluate(() =>
      document.documentElement.getAttribute("style"),
    );
    console.log(
      `  <html> attribute writes: ${probe?.root.length ?? 0} (style now: ${rootStyle ?? "none"})`,
    );
    for (const w of probe?.root ?? []) console.log(`    ${w}`);
    if (!quiet || round === 1)
      for (const c of styles)
        console.log(`    ${c.op} ${c.id} ${c.chars}ch  ${c.head}`);
    if (!quiet) report(profile);
    if (out !== undefined)
      writeFileSync(
        `${out}-${label}-${round}.cpuprofile`,
        JSON.stringify(profile),
      );
  };

  for (let round = 1; round <= rounds; round++) {
    await measure("enter", round, () => fullscreen.click());
    await page.waitForTimeout(1000);
    // Back to the desktop the one way there is (no shortcut: Esc belongs to
    // whatever is open): the action bar's Layout control. The popover opens
    // before the measurement, so only the radio's click is billed to the exit.
    await openFloatingActionBar(page);
    await page.locator('[data-ui-owner^="ViewOptionsButton@"]').click();
    const desktop = page.getByRole("radio", { name: "Desktop", exact: true });
    await desktop.waitFor();
    await page.waitForTimeout(500);
    await measure("exit", round, () => desktop.click());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
  }
  // Round 1 styles the solo-only and desktop-only subtrees for the first
  // time (cold); later rounds are the steady state.
  console.log(`\nround 1 (cold) | median of rounds 2–${rounds} (warm):`);
  for (const [label, byMetric] of Object.entries(deltas)) {
    const cells = METRICS.filter((k) => k.endsWith("Duration")).map((k) => {
      const [first = 0, ...rest] = byMetric[k] ?? [];
      const warm = [...rest].sort((a, b) => a - b);
      const mid = warm[Math.floor(warm.length / 2)];
      const ms = (v: number | undefined) =>
        v === undefined ? "–" : `${(v * 1000).toFixed(0)}ms`;
      return `${k.replace("Duration", "")} ${ms(first)} | ${ms(mid)}`;
    });
    for (const k of ["StyledElements", "BigRecalcs"]) {
      const [first = 0, ...rest] = byMetric[k] ?? [];
      const warm = [...rest].sort((a, b) => a - b);
      cells.push(`${k} ${first} | ${warm[Math.floor(warm.length / 2)] ?? "–"}`);
    }
    console.log(`  ${label}: ${cells.join(" · ")}`);
  }
  if (out !== undefined)
    console.log(`\nwrote ${out}-<enter|exit>-<round>.cpuprofile`);
});

/** Elements restyled by each style recalc (UpdateLayoutTree) in a trace. */
function styleRecalcs(trace: Buffer): number[] {
  const { traceEvents } = JSON.parse(trace.toString("utf8")) as {
    traceEvents: TraceEvent[];
  };
  return traceEvents
    .filter(
      (e) => e.name === "UpdateLayoutTree" && (e.ph === "X" || e.ph === "E"),
    )
    .map((e) => e.args?.elementCount ?? e.args?.data?.elementCount ?? 0)
    .filter((n) => n > 0);
}

/**
 * What scheduled the style invalidations in a trace, most frequent first: per
 * tracking event, the node and what changed on it (class, attribute, id,
 * pseudo state, a style sheet) or the reason given.
 */
function invalidationReport(trace: Buffer): void {
  const { traceEvents } = JSON.parse(trace.toString("utf8")) as {
    traceEvents: TraceEvent[];
  };
  const tally = new Map<string, number>();
  for (const e of traceEvents) {
    if (!e.name.endsWith("InvalidationTracking")) continue;
    const d = e.args?.data ?? {};
    const what = [
      "changedClass",
      "changedAttribute",
      "changedId",
      "changedPseudo",
      "reason",
    ]
      .filter((k) => d[k] !== undefined)
      .map((k) => `${k}=${JSON.stringify(d[k])}`)
      .join(" ");
    const key = `${e.name.replace("InvalidationTracking", "")} ${String(d.nodeName ?? "?")} ${what}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  console.log("  invalidations (count, kind, node, what):");
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1]).slice(0, 60))
    console.log(`    ${n} ${k}`);
}

/** Self time per function and per source file, from the profile's samples. */
function report(profile: CpuProfile): void {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  const byFile = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    if (n === undefined) return;
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    const { functionName, url, lineNumber } = n.callFrame;
    if (functionName === "(idle)") return;
    const file = url === "" ? `(${functionName || "native"})` : fileOf(url);
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    byFile.set(file, (byFile.get(file) ?? 0) + dt);
  });
  const sorted = (m: Map<string, number>, n: number) =>
    [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log("  self time by file:");
  for (const [k, v] of sorted(byFile, 15))
    console.log(`    ${v.toFixed(0)}ms ${k}`);
  console.log("  top self-time functions:");
  for (const [k, v] of sorted(self, top))
    console.log(`    ${v.toFixed(0)}ms ${k}`);
}

/** The last two path segments of a script URL (artifact dir + file). */
function fileOf(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}
