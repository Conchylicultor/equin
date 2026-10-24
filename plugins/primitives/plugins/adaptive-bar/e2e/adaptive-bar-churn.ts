/**
 * The behavioural proof no fixed-width suite can give: what every adaptive bar
 * on a page does across a SLOW, CONTINUOUS viewport resize — the way a user
 * actually drags a window edge, not a handful of discrete widths sampled in
 * isolation.
 *
 * `core/*.test.ts` proves the fit math without a layout engine. The jsdom suite
 * proves React never unmounted a relocated subtree. `./equin check
 * layout-geometry` proves the boxes do not collide, under a real layout engine,
 * but only for the fixture gallery and only at a handful of fixed widths. None
 * of them drive hundreds of small resize steps back-to-back the way a real drag
 * does, and that is exactly the shape that produced the transient
 * `no-convergence` fault this script exists to reproduce and rule back out: a
 * fault that only shows up between measured widths, under real
 * ResizeObserver churn.
 *
 * This script does not target the layout-harness fixture — it drives WHATEVER
 * URL it is pointed at, and discovers every adaptive bar the route happens to
 * render, so it doubles as a general "did this route's bars survive a resize"
 * regression check for any app, not just the primitive's own gallery.
 *
 * Manual only — nothing runs this automatically.
 *
 *   ./equin build
 *   ./equin run plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-churn.ts [--path /agents] [--headed]
 */
import {
  numArg,
  pageUrl,
  report,
  snap,
  withBrowser,
  waitForNetworkIdle,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/adaptive-bar-churn";

/** Measure/record only every Nth swept step — every step would be far too noisy. */
const SAMPLE_EVERY = 5;

/** A container the item host renders — `data-adaptive-bar-item="<id>"`. */
interface ItemRecord {
  id: string;
  el: Element;
}

/** One bar, discovered once and tracked for the rest of the run. */
interface BarRecord {
  id: string;
  el: Element;
  items: ItemRecord[];
}

interface WindowChurnRegistry {
  bars: BarRecord[];
}

/** What one sampled width found, per bar. */
interface BarSample {
  id: string;
  width: number;
  inlineCount: number;
  relocatedCount: number;
  triggerVisible: boolean;
  /** Item ids that measured narrower with shrink allowed than with it forced off. */
  squeezedIds: string[];
}

interface SampleResult {
  bars: BarSample[];
  /** Item ids rendered MORE than once — the one thing the primitive must never do. */
  mountViolations: { id: string; count: number }[];
  /** Item ids the host stopped rendering. Reported, never a failure. */
  unmounted: string[];
}

interface BarAgg {
  id: string;
  minWidth: number;
  maxWidth: number;
  minInline: number;
  maxInline: number;
  everTriggerVisible: boolean;
  samples: number;
}

await withBrowser(async (h) => {
  const url = pageUrl("/");

  const from = numArg("from", 1400);
  const to = numArg("to", 560);
  const step = numArg("step", 12);
  const settleMs = numArg("settle", 45);

  const r = report("adaptive-bar — continuous width-sweep churn");
  r.note(`target: ${url}`);
  r.note(
    `sweep: ${String(from)}px → ${String(to)}px → ${String(from)}px, step ${String(step)}px, settle ${String(settleMs)}ms`,
  );

  const { page, captured } = await h.session({
    viewport: { width: from, height: 900 },
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForNetworkIdle(page, { timeoutMs: 30_000 });
  await page.waitForTimeout(500);
  await snap(page, OUT, "1-start");

  // The down-then-up sweep sequence. `turnaroundIndex` and the final index are
  // the two endpoints the spec calls out — the widest and narrowest points a
  // real drag would actually rest at — sampled unconditionally regardless of
  // where SAMPLE_EVERY would otherwise land.
  const widths: number[] = [];
  for (let w = from; w > to; w -= step) widths.push(w);
  widths.push(to);
  const turnaroundIndex = widths.length - 1;
  for (let w = to + step; w < from; w += step) widths.push(w);
  widths.push(from);
  const lastIndex = widths.length - 1;

  const sampleIndices = new Set<number>([0, turnaroundIndex, lastIndex]);
  for (let i = 0; i < widths.length; i += SAMPLE_EVERY) sampleIndices.add(i);

  const bars = new Map<string, BarAgg>();
  const squeezeEvents: string[] = [];
  const mountViolations = new Map<string, string>();
  /** Occupants the host stopped rendering mid-sweep — noted, not judged. */
  const unmounted = new Set<string>();

  /**
   * Runs entirely in the page. `window.__abChurn` is the bar registry: a bar
   * and its occupants are discovered ONCE, the first time an item container is
   * seen sitting inline under a non-zero-width parent, and then tracked by DOM
   * reference for the rest of the run — because once an occupant relocates,
   * its parent is the (zero-width, hidden) panel dock, not the bar, and the
   * only way to still attribute it to "its" bar at that point is to already
   * know which bar it came from.
   */
  async function sampleAt(): Promise<SampleResult> {
    return page.evaluate((): SampleResult => {
      const w = window as unknown as { __abChurn?: WindowChurnRegistry };
      if (!w.__abChurn) w.__abChurn = { bars: [] };
      const reg = w.__abChurn;

      function barIdentity(el: Element): string {
        const marker = el.closest("[data-lineage]");
        if (marker) {
          const pluginId = marker.getAttribute("data-plugin-id") ?? "";
          const slotId = marker.getAttribute("data-slot-id") ?? "";
          if (pluginId || slotId) return `${pluginId}#${slotId}`;
        }
        return el.className || `bar-${String(reg.bars.length)}`;
      }

      // ── discover any item containers not yet attributed to a bar ──────────
      const allItemEls = Array.from(
        document.querySelectorAll("[data-adaptive-bar-item]"),
      );
      for (const itemEl of allItemEls) {
        const alreadyTracked = reg.bars.some((b) =>
          b.items.some((it) => it.el === itemEl),
        );
        if (alreadyTracked) continue;
        const parent = itemEl.parentElement;
        if (parent === null) continue;
        // The panel dock and parking dock are zero-width/hidden while closed —
        // an item currently relocated there is not yet attributable to a bar.
        // It will be picked up the first time it is next seen inline.
        if (parent.getBoundingClientRect().width <= 0) continue;
        let bar = reg.bars.find((b) => b.el === parent);
        if (!bar) {
          bar = { id: barIdentity(parent), el: parent, items: [] };
          reg.bars.push(bar);
        }
        bar.items.push({
          id: itemEl.getAttribute("data-adaptive-bar-item") ?? "",
          el: itemEl,
        });
      }

      // ── per-bar stats at the current width ─────────────────────────────
      const barsOut: BarSample[] = [];
      for (const bar of reg.bars) {
        const barRect = bar.el.getBoundingClientRect();
        let inline = 0;
        const squeezed: string[] = [];
        for (const it of bar.items) {
          if (it.el.parentElement !== bar.el) continue;
          inline++;
          const htmlEl = it.el as HTMLElement;
          const shrinkable = htmlEl.getBoundingClientRect().width;
          const prevShrink = htmlEl.style.flexShrink;
          htmlEl.style.flexShrink = "0";
          const unshrunk = htmlEl.getBoundingClientRect().width;
          htmlEl.style.flexShrink = prevShrink;
          if (Math.abs(unshrunk - shrinkable) > 0.5) squeezed.push(it.id);
        }
        const trigger = bar.el.querySelector(
          "[data-adaptive-bar-trigger]",
        ) as HTMLElement | null;
        barsOut.push({
          id: bar.id,
          width: barRect.width,
          inlineCount: inline,
          relocatedCount: bar.items.length - inline,
          triggerVisible: trigger !== null && !trigger.hidden,
          squeezedIds: squeezed,
        });
      }

      // ── mount-count integrity, over every item ever tracked by any bar ──
      //
      // The claim is ONE instance, not a permanent one. A second copy is the
      // primitive failing at the thing it exists for — measuring by rendering a
      // widget twice, or a portal container swapped and the subtree rebuilt.
      // ZERO is the host's business and routinely legitimate: this script drives
      // a real route, and an occupant set can be data-driven (the pinned
      // prompt-template chips are the head of a usage-ranked list, so a chip
      // genuinely leaves when the ranking arrives). Failing on that would make
      // the script report the app's data settling as a layout bug.
      const seenIds = new Set<string>();
      for (const bar of reg.bars)
        for (const it of bar.items) seenIds.add(it.id);
      const mountViolationsOut: { id: string; count: number }[] = [];
      const unmountedOut: string[] = [];
      for (const id of seenIds) {
        const count = document.querySelectorAll(
          `[data-adaptive-bar-item="${CSS.escape(id)}"]`,
        ).length;
        if (count > 1) mountViolationsOut.push({ id, count });
        else if (count === 0) unmountedOut.push(id);
      }

      return {
        bars: barsOut,
        mountViolations: mountViolationsOut,
        unmounted: unmountedOut,
      };
    });
  }

  for (let i = 0; i < widths.length; i++) {
    const w = widths[i]!;
    await page.setViewportSize({ width: w, height: 900 });
    if (!sampleIndices.has(i)) continue;

    await page.waitForTimeout(settleMs);
    const result = await sampleAt();

    for (const b of result.bars) {
      let agg = bars.get(b.id);
      if (!agg) {
        agg = {
          id: b.id,
          minWidth: b.width,
          maxWidth: b.width,
          minInline: b.inlineCount,
          maxInline: b.inlineCount,
          everTriggerVisible: b.triggerVisible,
          samples: 0,
        };
        bars.set(b.id, agg);
      }
      agg.minWidth = Math.min(agg.minWidth, b.width);
      agg.maxWidth = Math.max(agg.maxWidth, b.width);
      agg.minInline = Math.min(agg.minInline, b.inlineCount);
      agg.maxInline = Math.max(agg.maxInline, b.inlineCount);
      agg.everTriggerVisible ||= b.triggerVisible;
      agg.samples++;
      for (const sid of b.squeezedIds) {
        squeezeEvents.push(`${b.id} item="${sid}" at ${String(w)}px`);
      }
    }

    for (const v of result.mountViolations) {
      mountViolations.set(
        v.id,
        `${v.id} count=${String(v.count)} at ${String(w)}px`,
      );
    }
    for (const id of result.unmounted) unmounted.add(id);

    if (i === turnaroundIndex) await snap(page, OUT, "2-narrowest");
  }

  await snap(page, OUT, "3-end");

  // ── summary: one line per bar, not one line per (bar, sample) ────────────
  if (bars.size === 0) {
    r.note(
      "no adaptive bars were discovered on this page — either the route has none, or none of its bars ever showed an inline occupant during the sweep (pass --path to a route that has one).",
    );
  }
  for (const agg of bars.values()) {
    r.note(
      `${agg.id} — swept ${agg.minWidth.toFixed(0)}–${agg.maxWidth.toFixed(0)}px, ` +
        `inline count ${String(agg.minInline)}–${String(agg.maxInline)}, ` +
        `trigger ${agg.everTriggerVisible ? "appeared" : "never appeared"}, ` +
        `${String(agg.samples)} samples`,
    );
  }

  // ── the actual assertions ─────────────────────────────────────────────
  r.ok(
    "no page errors during the sweep",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  r.ok(
    "no occupant was ever squeezed while inline (flexShrink:0 measured wider than as-rendered)",
    squeezeEvents.length === 0,
    squeezeEvents.slice(0, 10).join(" | "),
  );
  r.ok(
    "no occupant was ever rendered twice",
    mountViolations.size === 0,
    [...mountViolations.values()].slice(0, 10).join(" | "),
  );
  if (unmounted.size > 0) {
    r.note(
      `the host stopped rendering ${String(unmounted.size)} occupant(s) during the sweep ` +
        `(${[...unmounted].slice(0, 4).join(", ")}) — a data-driven occupant set, not a bar fault.`,
    );
  }

  r.note(
    "adaptive-bar faults (no-slack / row-overflow / no-convergence / iframe-relocation) are filed as " +
      'reports of kind "adaptive-bar", independent of this script\'s own assertions above. ' +
      "Check Debug → Reports, or query_db: select * from reports where kind = 'adaptive-bar';",
  );

  await r.finish();
});
