/**
 * The proof no other suite can give: a bar whose **row is merely over-full** —
 * so its own cell resolves to exactly 0px while fully laid out — is **still
 * deciding** afterwards. It did not read that 0 as the shrink-wrap ratchet's
 * terminal state, file a `no-slack` fault, and latch the degraded ceiling
 * (everything back in the row, CSS clipping, and never an eviction again) for
 * the life of the mount.
 *
 * Why a healthy bar measures 0 at all: the bar declares itself `min-w-0 flex-1`,
 * i.e. `flex: 1 1 0%`, which is what makes its own
 * `getBoundingClientRect().width` the room it was given. When the row's OTHER
 * cells over-fill their container, free space is negative — and a cell whose
 * flex base size is 0 has no basis on which to absorb a share of the shrinkage,
 * so it resolves to 0px while generating a perfectly ordinary box. Nothing is
 * wrong with that host. There is simply no room at this width, and there will be
 * again when the row widens.
 *
 * Until `research/2026-08-18-global-adaptive-bar-zero-width-recovery.md` the bar
 * accused the host on that number. It now re-admits every occupant, clears the
 * premise watermark and re-asks the differential probe: a shrink-wrapping host
 * then measures its own content and is faulted in the words that name the
 * defect, while an over-full row finds nothing evicted on the next pass, latches
 * nothing, and files ONE non-latching note saying its row is over-full. This
 * script drives the second case in a real engine.
 *
 * Why the other three suites cannot express it:
 *
 * - `core/*.test.ts` has no layout engine at all — negative free space is not a
 *   number the fit is ever handed.
 * - `web/__tests__/` (jsdom) models the over-full row through the primitive's
 *   own measurement seam: the test supplies 0 as a width, which is the thing
 *   under test being asserted rather than observed. Only a real engine decides
 *   that a `flex: 1 1 0%` cell in an over-full row is 0 *and* still laid out.
 * - `./equin check layout-geometry` mutates synchronously and never
 *   reverts: its style writes are one-shot with no restore phase, and the bar's
 *   resize callback is RAF-debounced — so an inject-then-remove inside one task
 *   coalesces into no observation at all, and the 0px pass this script exists to
 *   force never runs.
 *
 * Route-agnostic: it drives WHATEVER URL it is pointed at and discovers every
 * adaptive bar the route happens to render, so it doubles as a "do this route's
 * bars survive a cramped row" check for any app.
 *
 * Manual only — nothing runs this automatically.
 *
 *   ./equin build
 *   ./equin run plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-overfull-row.ts [--path /agents] [--headed]
 */
import {
  numArg,
  pageUrl,
  report,
  snap,
  withBrowser,
  waitForNetworkIdle,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/adaptive-bar-overfull-row";

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
 * which is what makes the over-fill survivable: a bar whose cell is 0px wide is
 * still the same node, and an occupant sitting in the (zero-width) panel dock is
 * attributable to its bar only because we already knew where it came from.
 */
interface WindowOverfullRegistry {
  bars: BarRecord[];
  /** The row currently over-filled, plus the rigid node injected into it. */
  injected?: { row: HTMLElement; el: HTMLElement };
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

/** Which row the rigid sibling went into, and how that row was described. */
type OverfillResult =
  { ok: true; barId: string; row: string } | { ok: false; reason: string };

await withBrowser(async (h) => {
  const url = pageUrl("/agents");

  const from = numArg("from", 1400);
  const to = numArg("to", 480);
  const step = numArg("step", 40);
  const settleMs = numArg("settle", 120);
  /**
   * How wide the rigid sibling is. It only has to be wider than any row this app
   * renders — the point is that the row's other cells over-fill it, not by how
   * much — so this is deliberately far past any real viewport.
   */
  const fillerPx = numArg("filler", 5000);

  const r = report("adaptive-bar — an over-full row does not latch the bar");
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
   * bar's resize callback is RAF-debounced, so injecting the rigid sibling and
   * removing it again inside one task are one coalesced observation of an
   * unchanged size — the 0px pass never runs and the script would prove nothing
   * at all.
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
   * placement. Discovery mirrors `adaptive-bar-hidden-host.ts`: an item
   * container's parent IS its bar's root, and an item currently parked in the
   * panel dock (zero width while closed) is not attributable yet — it is picked
   * up the first time it is next seen inline.
   */
  async function sampleBars(): Promise<BarSample[]> {
    return page.evaluate((): BarSample[] => {
      const w = window as unknown as { __abOverfull?: WindowOverfullRegistry };
      w.__abOverfull ??= { bars: [] };
      const reg = w.__abOverfull;

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
   * Over-fill the bar's own row: append one rigid sibling of the bar's root,
   * inside the bar root's parent — which IS the row, since the bar is a cell of
   * it.
   *
   * `flex: 0 0 auto` is the load-bearing half of the inline style. A shrinkable
   * filler would simply absorb the overflow itself and the bar would keep its
   * width, so the mutation would prove nothing; an un-shrinkable one forces free
   * space genuinely negative, which is the only way the bar's `flex: 1 1 0%`
   * cell resolves to 0 while still generating a box. The `data-*` marker is how
   * the node is found again to be removed — the registry holds the reference,
   * and the attribute is there for anyone reading a screenshot's DOM.
   */
  async function overfillRow(
    barId: string,
    px: number,
  ): Promise<OverfillResult> {
    return page.evaluate(
      ({ id, width }: { id: string; width: number }): OverfillResult => {
        const w = window as unknown as {
          __abOverfull?: WindowOverfullRegistry;
        };
        const reg = w.__abOverfull;
        if (!reg) return { ok: false, reason: "no bar registry on the page" };
        const bar = reg.bars.find((b) => b.id === id);
        if (!bar)
          return { ok: false, reason: `bar ${id} is no longer tracked` };
        const row = bar.el.parentElement;
        if (!(row instanceof HTMLElement)) {
          return { ok: false, reason: `bar ${id} has no element row to fill` };
        }
        const filler = document.createElement("div");
        filler.setAttribute("data-adaptive-bar-e2e-filler", "1");
        filler.style.flex = "0 0 auto";
        filler.style.width = `${String(width)}px`;
        filler.style.height = "1px";
        row.append(filler);
        reg.injected = { row, el: filler };
        const cls = row.className
          ? `.${row.className.split(/\s+/)[0] ?? ""}`
          : "";
        return {
          ok: true,
          barId: id,
          row: `${row.tagName.toLowerCase()}${cls} (bar root's parent)`,
        };
      },
      { id: barId, width: px },
    );
  }

  /** Take the rigid sibling back out, restoring the row to what the app rendered. */
  async function removeOverfill(): Promise<boolean> {
    return page.evaluate((): boolean => {
      const w = window as unknown as { __abOverfull?: WindowOverfullRegistry };
      const injected = w.__abOverfull?.injected;
      if (!injected) return false;
      injected.el.remove();
      delete w.__abOverfull?.injected;
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

  // ── 2. over-fill the row, wait REAL time, then take the filler back out ──
  const filled = await overfillRow(barId, fillerPx);
  r.ok(
    `a rigid ${String(fillerPx)}px sibling was injected into the bar's row`,
    filled.ok,
    filled.ok ? undefined : filled.reason,
  );
  if (!filled.ok) {
    await r.finish();
    return;
  }
  r.note(`over-filled row: ${filled.row}`);
  await settle();
  await settle();
  await snap(page, OUT, "2-overfull");

  // The premise of the whole script, stated as an assertion rather than assumed:
  // the bar's cell really does resolve to 0 here. If the route's row scrolls,
  // wraps, or otherwise refuses to go negative, the bar keeps a width and the
  // 0px branch is never reached — so say what was measured instead of passing on
  // three assertions that would then be about nothing.
  const overfull = await sampleBar(barId);
  r.note(
    overfull === undefined
      ? "the bar is no longer tracked while over-filled"
      : `bar width while over-filled: ${overfull.width.toFixed(2)}px ` +
          `(${String(overfull.inlineCount)} inline, ${String(overfull.relocatedCount)} relocated)`,
  );
  const wentToZero = overfull !== undefined && overfull.width <= 1;
  r.ok(
    "the bar's flex cell resolves to ~0px while the row is over-full",
    wentToZero,
    overfull === undefined
      ? "bar vanished while over-filled"
      : `measured ${overfull.width.toFixed(2)}px — this row does not go negative ` +
          "(it scrolls, wraps, or the bar is not a flex cell of it), so the 0px branch was never reached; " +
          "point --path at a route whose bar sits in a plain single-line row",
  );
  if (!wentToZero) {
    await removeOverfill();
    await r.finish();
    return;
  }

  const removed = await removeOverfill();
  r.ok("the rigid sibling was removed from the row", removed);
  await settle();
  await settle();
  await snap(page, OUT, "3-restored");

  // ── 3. the bar is still deciding ────────────────────────────────────────
  //
  // A latched bar has taken the ceiling: every occupant back in the row, CSS
  // clipping, and no eviction ever again. So each of the three readings below is
  // one a latched bar cannot produce.
  const after = await sampleBar(barId);
  r.ok(
    "the bar still exists after the over-full row was restored",
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
    "the bar still relocates the same occupants once the row has room again",
    after.relocatedCount === relocatedBefore,
    `relocated ${String(after.relocatedCount)} after the over-fill, ${String(relocatedBefore)} before it ` +
      "(0 after is the degraded ceiling — the latch this script exists to catch)",
  );

  // Widen back to a width the bar already held everything at: a bar that is
  // still deciding re-admits its occupants, a latched one has nothing to admit.
  //
  // Its premise is "the same occupants fitted at this width before", so it is
  // only asked when the set really is the same one. An occupant set can be
  // data-driven — the pinned prompt-template chips are — and a bar holding two
  // MORE chips than it started with may legitimately not fit them at `from`.
  // Asserting through that would report the host's data settling as a latch.
  // The claim the latch actually fails is the one above and the one below:
  // a latched bar relocates zero occupants at every width, for ever.
  await page.setViewportSize({ width: from, height: 900 });
  await settle();
  const wide = await sampleBar(barId);
  const sameSet =
    wide !== undefined &&
    after.unmountedCount === 0 &&
    wide.unmountedCount === 0 &&
    wide.inlineCount + wide.relocatedCount ===
      after.inlineCount + after.relocatedCount;
  if (!sameSet) {
    r.note(
      "skipped 'widening re-admits the relocated occupants': the host's occupant set moved " +
        "during the cycle, so 'these fitted at this width before' is no longer a claim about " +
        "the same set. The two assertions either side of it still hold the latch to account.",
    );
  } else {
    r.ok(
      "widening re-admits the relocated occupants",
      wide.relocatedCount === 0,
      `still ${String(wide.relocatedCount)} relocated at ${String(from)}px`,
    );
  }

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
  await snap(page, OUT, "4-narrow-again");

  r.ok(
    "no page errors during the over-fill cycle",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );

  r.note(
    'a no-slack fault is filed as a report of kind "adaptive-bar", independent of the assertions above, ' +
      "and this cycle is EXPECTED to file exactly one: the non-latching note whose message says the row " +
      "is over-full and that nothing was latched. A report whose message instead says the bar stopped " +
      "deciding means the recovery was exhausted, which is a finding even when the assertions pass. " +
      "Check Debug → Reports, or query_db: select * from reports where kind = 'adaptive-bar';",
  );

  await r.finish();
});
