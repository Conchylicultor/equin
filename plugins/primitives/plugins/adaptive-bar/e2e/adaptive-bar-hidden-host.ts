/**
 * The proof no other suite can give: a bar whose ancestor is hidden with
 * `display: none` and then shown again is **still deciding** — it did not latch
 * the degraded ceiling (everything back in the row, CSS clipping, and never an
 * eviction again) on the 0px it measured while it generated no box.
 *
 * Keeping a surface mounted but not rendered is this app's general contract, and
 * every spelling of it is `display: none` — an unfocused tab
 * (`apps-core/surface`'s `surface-body.tsx`, the mechanism this script copies),
 * a minimized floating window, a collapsed miller column. So an ordinary bar in
 * an ordinary app gets hidden and shown many times a session, and each hide is a
 * chance to latch.
 *
 * Why the other three suites cannot express it:
 *
 * - `core/*.test.ts` has no layout engine at all — it is the fit math, and
 *   "the row generates no box" is not a number the fit is ever handed.
 * - `web/__tests__/` (jsdom) models the hide through the primitive's own
 *   measurement seam: the test supplies 0 as a width, which is exactly the
 *   thing under test being asserted rather than observed. Only a real engine
 *   decides what a `display: none` subtree measures, and only a real engine
 *   fires the `ResizeObserver` that drives the pass.
 * - `./equin check layout-geometry` mutates synchronously and never
 *   reverts: the harness's style writes are one-shot with no restore phase, and
 *   the bar's resize callback is RAF-debounced — so a hide-then-show inside one
 *   task coalesces into no size change at all, and the hidden pass this script
 *   exists to force never runs.
 *
 * Route-agnostic: it drives WHATEVER URL it is pointed at and discovers every
 * adaptive bar the route happens to render, so it doubles as a "does this
 * route's bars survive being backgrounded" check for any app.
 *
 * Manual only — nothing runs this automatically.
 *
 *   ./equin build
 *   ./equin run plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-hidden-host.ts [--path /agents] [--headed]
 */
import {
  numArg,
  pageUrl,
  report,
  snap,
  withBrowser,
  waitForNetworkIdle,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/adaptive-bar-hidden-host";

/** A container the item host renders — `data-adaptive-bar-item="<id>"`. */
interface ItemRecord {
  id: string;
  el: Element;
}

/** One bar, discovered once and tracked by DOM reference for the rest of the run. */
interface BarRecord {
  id: string;
  el: Element;
  items: ItemRecord[];
}

/**
 * The page-side registry. Bars are tracked by DOM reference and NOT re-queried,
 * which is what makes the hide survivable: a `display: none` bar is still the
 * same node, and an occupant sitting in the (zero-width) panel dock is
 * attributable to its bar only because we already knew where it came from.
 */
interface WindowHiddenHostRegistry {
  bars: BarRecord[];
  /** The ancestor currently hidden, plus the inline `display` to put back. */
  hidden?: { el: HTMLElement; prevDisplay: string };
}

/** What one measurement found, per bar. */
interface BarSample {
  id: string;
  width: number;
  inlineCount: number;
  relocatedCount: number;
  /** Occupants the HOST stopped rendering — reported, never counted as a move. */
  unmountedCount: number;
  triggerVisible: boolean;
}

/** Which ancestor the hide was applied to, and how it was chosen. */
type HideResult =
  { ok: true; barId: string; ancestor: string } | { ok: false; reason: string };

await withBrowser(async (h) => {
  const url = pageUrl("/agents");

  const from = numArg("from", 1400);
  const to = numArg("to", 480);
  const step = numArg("step", 40);
  const settleMs = numArg("settle", 120);

  const r = report("adaptive-bar — a hidden host does not latch the bar");
  r.note(`target: ${url}`);
  r.note(
    `narrowing ${String(from)}px → ${String(to)}px in ${String(step)}px steps to find a bar that relocates`,
  );

  const { page, captured } = await h.session({
    viewport: { width: from, height: 900 },
  });

  /**
   * Two real animation frames, then a real timeout.
   *
   * Load-bearing, and the reason this test cannot live in the geometry gate: the
   * bar's resize callback is RAF-debounced, so a hide and a show inside one task
   * are one coalesced observation of an unchanged size — the hidden pass never
   * runs and the script would prove nothing at all.
   */
  async function settle(): Promise<void> {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              resolve();
            }),
          );
        }),
    );
    await page.waitForTimeout(settleMs);
  }

  /**
   * Discover any not-yet-tracked bars, then report every tracked bar's current
   * placement. Discovery mirrors `adaptive-bar-churn.ts`: an item container's
   * parent IS its bar's root, and an item currently parked in the panel dock
   * (zero width while closed) is not attributable yet — it is picked up the
   * first time it is next seen inline.
   */
  async function sampleBars(): Promise<BarSample[]> {
    return page.evaluate((): BarSample[] => {
      const w = window as unknown as { __abHidden?: WindowHiddenHostRegistry };
      w.__abHidden ??= { bars: [] };
      const reg = w.__abHidden;

      function barIdentity(el: Element): string {
        const marker = el.closest("[data-lineage]");
        if (marker) {
          const pluginId = marker.getAttribute("data-plugin-id") ?? "";
          const slotId = marker.getAttribute("data-slot-id") ?? "";
          if (pluginId || slotId) return `${pluginId}#${slotId}`;
        }
        return el.className || `bar-${String(reg.bars.length)}`;
      }

      for (const itemEl of document.querySelectorAll(
        "[data-adaptive-bar-item]",
      )) {
        const tracked = reg.bars.some((b) =>
          b.items.some((it) => it.el === itemEl),
        );
        if (tracked) continue;
        const parent = itemEl.parentElement;
        if (parent === null) continue;
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

      return reg.bars.map((bar): BarSample => {
        // Three states, and the third must not be read as the second: still in
        // the row, relocated into the panel, or no longer in the document at
        // all. The last one is the HOST's business (an occupant set can be
        // data-driven), and counting it as a relocation would make the app's
        // data settling look like the bar deciding.
        let inline = 0;
        let relocated = 0;
        let unmounted = 0;
        for (const it of bar.items) {
          if (!it.el.isConnected) unmounted++;
          else if (it.el.parentElement === bar.el) inline++;
          else relocated++;
        }
        const trigger = bar.el.querySelector("[data-adaptive-bar-trigger]");
        return {
          id: bar.id,
          width: bar.el.getBoundingClientRect().width,
          inlineCount: inline,
          relocatedCount: relocated,
          unmountedCount: unmounted,
          triggerVisible:
            trigger instanceof HTMLElement ? !trigger.hidden : false,
        };
      });
    });
  }

  /** The one bar under test, by the id `sampleBars` reports. */
  async function sampleBar(barId: string): Promise<BarSample | undefined> {
    const bars = await sampleBars();
    return bars.find((b) => b.id === barId);
  }

  /**
   * Hide an ancestor of the bar's root the way the app itself does: the nearest
   * `[data-tab-id]` container, which is the very box `surface-body.tsx` sets
   * `display: none` on for an unfocused tab. A route that renders its bar
   * outside any tab container falls back to the bar root's own parent — still an
   * ancestor, still the same mechanism.
   */
  async function hideHost(barId: string): Promise<HideResult> {
    return page.evaluate((id: string): HideResult => {
      const w = window as unknown as { __abHidden?: WindowHiddenHostRegistry };
      const reg = w.__abHidden;
      if (!reg) return { ok: false, reason: "no bar registry on the page" };
      const bar = reg.bars.find((b) => b.id === id);
      if (!bar) return { ok: false, reason: `bar ${id} is no longer tracked` };
      const tabHost = bar.el.closest("[data-tab-id]");
      const host = tabHost ?? bar.el.parentElement;
      if (!(host instanceof HTMLElement)) {
        return {
          ok: false,
          reason: `bar ${id} has no element ancestor to hide`,
        };
      }
      reg.hidden = { el: host, prevDisplay: host.style.display };
      host.style.display = "none";
      return {
        ok: true,
        barId: id,
        ancestor:
          tabHost === null
            ? `${host.tagName.toLowerCase()} (bar root's parent)`
            : `[data-tab-id="${host.getAttribute("data-tab-id") ?? ""}"]`,
      };
    }, barId);
  }

  /** Put the ancestor's own `display` back — never a blanket `block`. */
  async function showHost(): Promise<boolean> {
    return page.evaluate((): boolean => {
      const w = window as unknown as { __abHidden?: WindowHiddenHostRegistry };
      const hidden = w.__abHidden?.hidden;
      if (!hidden) return false;
      hidden.el.style.display = hidden.prevDisplay;
      delete w.__abHidden?.hidden;
      return true;
    });
  }

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForNetworkIdle(page, { timeoutMs: 30_000 });
  await page.waitForTimeout(500);

  // ── 1. narrow until a bar actually relocates something ──────────────────
  //
  // A proof that never reached its precondition proves nothing, so this is a
  // hard failure rather than a vacuous pass.
  let trippedId: string | undefined;
  let trippedWidth = from;
  let relocatedBefore = 0;
  for (let width = from; width >= to; width -= step) {
    await page.setViewportSize({ width, height: 900 });
    await settle();
    const bars = await sampleBars();
    // Strictly `relocatedCount > 0`, never "the ⋯ trigger appeared": every
    // assertion below compares against this number, and a precondition of 0
    // would let a latched bar (which relocates nothing, ever) satisfy them.
    const relocating = bars.find((b) => b.relocatedCount > 0);
    if (relocating) {
      trippedId = relocating.id;
      trippedWidth = width;
      relocatedBefore = relocating.relocatedCount;
      break;
    }
  }

  if (trippedId === undefined) {
    await snap(page, OUT, "0-no-relocation");
    r.fail(
      "a bar relocated an occupant out of its row (the test's precondition)",
      `no bar on ${url} ever moved an occupant out of its row between ${String(from)}px and ${String(to)}px — ` +
        "point --path at a route with a crowded bar, or widen the sweep with --to",
    );
    // `finish()` exits the process; the `return` is what tells the compiler so.
    await r.finish();
    return;
  }

  const barId = trippedId;
  r.note(
    `bar "${barId}" relocated ${String(relocatedBefore)} occupant(s) at ${String(trippedWidth)}px`,
  );
  await snap(page, OUT, "1-relocated");

  // ── 2. hide an ancestor, wait REAL time, show it again ──────────────────
  const hidden = await hideHost(barId);
  r.ok(
    "an ancestor of the bar was hidden with display:none",
    hidden.ok,
    hidden.ok ? undefined : hidden.reason,
  );
  if (!hidden.ok) {
    await r.finish();
    return;
  }
  r.note(`hidden ancestor: ${hidden.ancestor}`);
  await settle();
  await settle();

  const restored = await showHost();
  r.ok("the ancestor's display was restored", restored);
  await settle();
  await settle();
  await snap(page, OUT, "2-shown-again");

  // ── 3. the bar is still deciding ────────────────────────────────────────
  //
  // A latched bar has taken the ceiling: every occupant back in the row, CSS
  // clipping, and no eviction ever again. So each of the three readings below
  // is one a latched bar cannot produce.
  const after = await sampleBar(barId);
  r.ok(
    "the bar still exists after the hide/show cycle",
    after !== undefined,
    `bar "${barId}" is no longer tracked`,
  );
  if (after === undefined) {
    await r.finish();
    return;
  }

  if (after.unmountedCount > 0) {
    r.note(
      `the host stopped rendering ${String(after.unmountedCount)} occupant(s) during the cycle ` +
        "— a data-driven occupant set, not a bar fault, and not counted as a relocation.",
    );
  }

  r.ok(
    "the bar still relocates the same occupants after being shown again",
    after.relocatedCount === relocatedBefore,
    `relocated ${String(after.relocatedCount)} after the hide, ${String(relocatedBefore)} before it ` +
      "(0 after is the degraded ceiling — the latch this script exists to catch)",
  );

  // Widen back to a width the bar already held everything at: a bar that is
  // still deciding re-admits its occupants, a latched one has nothing to admit.
  await page.setViewportSize({ width: from, height: 900 });
  await settle();
  const wide = await sampleBar(barId);
  r.ok(
    "widening re-admits the relocated occupants",
    wide !== undefined && wide.relocatedCount === 0,
    wide === undefined
      ? "bar vanished"
      : `still ${String(wide.relocatedCount)} relocated at ${String(from)}px`,
  );

  // And narrowing again evicts again — the half that actually proves the bar is
  // running its search rather than sitting on one committed placement.
  await page.setViewportSize({ width: trippedWidth, height: 900 });
  await settle();
  const narrowAgain = await sampleBar(barId);
  r.ok(
    "narrowing again evicts again (the bar is still running its search)",
    narrowAgain !== undefined && narrowAgain.relocatedCount === relocatedBefore,
    narrowAgain === undefined
      ? "bar vanished"
      : `relocated ${String(narrowAgain.relocatedCount)} at ${String(trippedWidth)}px, expected ${String(relocatedBefore)}`,
  );
  await snap(page, OUT, "3-narrow-again");

  r.ok(
    "no page errors during the hide/show cycle",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );

  r.note(
    'a no-slack fault is filed as a report of kind "adaptive-bar", independent of the assertions above. ' +
      "Check Debug → Reports, or query_db: select * from reports where kind = 'adaptive-bar';",
  );

  await r.finish();
});
