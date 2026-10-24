/**
 * The geometry gate jsdom cannot give: in a real layout engine, does the box
 * hosting a slot-rendered `AdaptiveBar` actually end up growing — with nothing
 * declared on the contribution?
 *
 * Drives the conversation prompt row, whose template-chip strip is one of the
 * two slot-hosted bars in the repo (the other, Sonata's display picker, needs a
 * saved song to reach). Walks up from the bar and asserts in the browser's own
 * words: the bar declares itself the grow cell, at least one ancestor box
 * relayed that grow, and the bar ended up wider than the chips it decided to
 * render — a shrink-wrapping chain reports those last two equal, which is the
 * ratchet this primitive exists to prevent.
 *
 * Manual, like every `e2e/` script here:
 *
 *   ./equin run plugins/primitives/plugins/css/plugins/grow-relay/e2e/relayed-cell-grows.ts \
 *     --conv <conversationId> [--headed]
 */
import {
  boot,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const CONV = requireArg(
  "conv",
  "usage: relayed-cell-grows.ts --conv <conversationId> [--headed]",
);

/** How far above the bar a relay may legitimately sit (cell → wrapper → bar). */
const WALK = 8;

await withBrowser(async (h) => {
  const r = report("grow-relay: the relayed cell grows");
  const { page } = await h.session();
  // Wait on a chip rather than on network idle: the strip is the surface under
  // test, so an occupant of it IS "ready", and a cold deep-link boot can outlast
  // any fixed sleep.
  await boot(page, pathUrl(`agents/c/${CONV}`), {
    marker: "[data-adaptive-bar-item]",
    settleMs: 4000,
  });

  const found = await page.evaluate((walk: number) => {
    const width = (el: Element) => Math.round(el.getBoundingClientRect().width);
    // The prompt strip, told from the page's other bars by having occupants:
    // the pane-header bars on this route hold none.
    const bar = [
      ...document.querySelectorAll<HTMLElement>("[data-adaptive-bar-trigger]"),
    ]
      .map((t) => t.parentElement)
      .find(
        (b): b is HTMLElement =>
          b !== null &&
          b.querySelectorAll("[data-adaptive-bar-item]").length >= 3,
      );
    if (!bar) return null;

    const chips = [
      ...bar.querySelectorAll<HTMLElement>("[data-adaptive-bar-item]"),
    ].filter((c) => !c.hidden);

    // A `display:contents` ancestor generates no box and is neither a relay nor
    // an obstacle — skip it rather than counting it either way.
    const ancestors: { grow: string; width: number; cls: string }[] = [];
    let el = bar.parentElement;
    for (let i = 0; i < walk && el !== null; i++) {
      const cs = getComputedStyle(el);
      if (cs.display !== "contents") {
        ancestors.push({
          grow: cs.flexGrow,
          width: width(el),
          cls: el.className.slice(0, 70),
        });
      }
      el = el.parentElement;
    }
    return {
      barGrow: getComputedStyle(bar).flexGrow,
      barWidth: width(bar),
      chipsWidth: chips.reduce((n, c) => n + width(c), 0),
      chips: chips.length,
      ancestors,
    };
  }, WALK);

  // if/else rather than an early `r.finish()`: it is declared `never`, but TS
  // only narrows on that for an explicitly-annotated callee, and `r` is
  // inferred — so the reads below would be `possibly null` to tsc.
  if (found === null) {
    r.fail(
      "find the prompt strip",
      "no AdaptiveBar with occupants on this route",
    );
  } else {
    r.note(JSON.stringify(found));
    r.eq("the bar declares itself the grow cell", found.barGrow, "1");
    r.ok(
      "a box above the bar relayed the grow",
      found.ancestors.some((a) => a.grow === "1"),
      `no ancestor within ${String(WALK)} levels has flex-grow: 1 — the bar is reading its own content back as its width`,
    );
    r.ok(
      "the bar was given more room than its content",
      found.chips === 0 || found.barWidth > found.chipsWidth,
      `${String(found.barWidth)}px holding ${String(found.chipsWidth)}px of chips — its width follows its content`,
    );
  }
  await r.finish();
});
