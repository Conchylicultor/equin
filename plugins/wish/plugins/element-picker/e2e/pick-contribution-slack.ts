// E2E verification: the slack inside a contribution's own box belongs to that
// contribution.
//
// A render slot draws a layout cell around each contribution, and the cell is
// usually bigger than what the contribution paints in it — the conversation
// header's progress bar is 4px tall inside a 20px cell, so nearly everything you
// can point at there is slack. The identity used to be stamped on a wrapper
// INSIDE the cell, so a pick in the slack found no contribution marker above it
// and climbed to the enclosing pane. It is now stamped on the cell itself.
//
// Asserted on the DOM rather than by driving the picker: the picker's own walk
// (`collectLineage`) is covered by unit tests and is not what changed — what
// changed is which element carries the identity, and the honest live question is
// whether the element under that slack carries it.
//
// Usage: bun plugins/improve/plugins/element-picker/e2e/pick-contribution-slack.ts \
//          [--url <page with a small widget in a row slot>] [--headed]
import {
  pageUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const TARGET = pageUrl();

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(TARGET, { waitUntil: "domcontentloaded" });
  // `waitForFunction`, not `waitForSelector`: the markers are `display:contents`
  // (no box), and a visibility-based wait never settles on them.
  await page.waitForFunction(
    () => document.querySelectorAll('[data-lineage="contribution"]').length > 0,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);

  const found = await page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-lineage="contribution"]',
      ),
    ].filter((e) => !e.closest("[data-element-picker]"));

    // Slack = the band between the box's edge and the union of what it paints.
    // A band, not a pixel scan: it is O(children) and it is the actual shape of
    // the problem — a 4px bar centred in a 20px cell leaves an 8px band above
    // and below, and that band is what people point at.
    let best: {
      plugin: string;
      slot: string;
      boxless: boolean;
      cell: string;
      band: number;
    } | null = null;
    for (const b of boxes) {
      const r = b.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      let top = Infinity;
      let bottom = -Infinity;
      for (const k of b.querySelectorAll("*")) {
        const kr = k.getBoundingClientRect();
        if (kr.width === 0 || kr.height === 0) continue;
        top = Math.min(top, kr.top);
        bottom = Math.max(bottom, kr.bottom);
      }
      if (top === Infinity) continue;
      const band = Math.max(top - r.top, r.bottom - bottom);
      if (band < 3) continue;
      if (!best || band > best.band)
        best = {
          plugin: b.dataset.pluginId ?? "",
          slot: b.dataset.slotId ?? "",
          boxless: b.dataset.lineageBoxless !== undefined,
          cell: `${Math.round(r.width)}x${Math.round(r.height)}`,
          band: Math.round(band),
        };
    }
    return {
      total: boxes.length,
      realBoxes: boxes.filter((e) => e.dataset.lineageBoxless === undefined)
        .length,
      best,
    };
  });

  const r = report(
    "element-picker: the slack in a contribution's box is the contribution's",
  );
  r.note(
    `${found.total} contribution markers, ${found.realBoxes} of them real boxes`,
  );
  r.ok(
    "contributions are marked on a box, not only on a layout-neutral wrapper",
    found.realBoxes > 0,
    `realBoxes=${found.realBoxes}`,
  );
  const best = found.best;
  if (!best) {
    r.ok(
      "found a contribution box with slack to point at",
      false,
      "none on this page — pass --url a page with a small widget in a row slot",
    );
    await r.finish();
    return;
  }
  r.note(
    `widest slack: ${best.plugin} @ ${best.slot} — ${best.band}px band in a ${best.cell} box`,
  );
  r.ok(
    "the box under that slack names its plugin",
    best.plugin.length > 0,
    `plugin=${JSON.stringify(best.plugin)}`,
  );
  r.ok(
    "…and its slot",
    best.slot.length > 0,
    `slot=${JSON.stringify(best.slot)}`,
  );
  r.ok(
    "…and is a real box, so a pick can land on it",
    !best.boxless,
    `boxless=${best.boxless}`,
  );
  await r.finish();
});
