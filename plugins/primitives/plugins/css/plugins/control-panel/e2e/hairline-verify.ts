// The panel's defining feature, asserted in PIXELS: the container draws one
// hairline between its bands, and that hairline is visibly distinct from the
// surface the panel is painted on.
//
//   ./equin run plugins/primitives/plugins/css/plugins/control-panel/e2e/hairline-verify.ts
//   ./equin run plugins/primitives/plugins/css/plugins/control-panel/e2e/hairline-verify.ts --headed
//
// Why pixels and not the DOM. The rule shipped broken for exactly the reason a
// DOM check could not see: `cp-body > * + *` matched nothing, because every
// contributed panel arrives wrapped in the framework's `display: contents`
// lineage span — transparent to layout, opaque to selectors. `getComputedStyle`
// on the sections reported `border-top-width: 0px` and no assertion in the repo
// was reading it; the `layout-geometry` harness compares WIDTHS, so it is
// structurally unable to see a missing or invisible line. This script reads the
// composited pixels in the gap between two bands.
//
// It is self-falsifying: after the real assertions it paints the hairline
// transparent and re-runs the same probe, which must then find nothing. Without
// that, a probe looking at the wrong y would pass on every panel forever.
import {
  withBrowser,
  snap,
  arg,
  pathUrl,
  report,
  samplePixels,
  colorDistance,
  type Rgba,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/cp-hairline");
const url = pathUrl("/agents");

/** A line is "visible" at this max-per-channel distance from the panel's own
 *  background. Measured today: 46 in dark, ~39 in light — the same contrast
 *  `--border` has against `--card`, which is the identical token value to
 *  `--popover` in both modes. 10 is far below either and far above the 0 a
 *  same-as-background or absent line reports. */
const VISIBLE = 10;

interface Strip {
  /** Rows in the sampled band, top to bottom. */
  rows: Rgba[];
}

/** The colour that occupies most of a strip — the panel's own background, read
 *  off the render rather than resolved from a token, so a wrong `--chrome-mask`
 *  is caught too. */
function modal(strip: Strip): Rgba {
  let best = strip.rows[0]!;
  let bestN = 0;
  for (const c of strip.rows) {
    const n = strip.rows.filter((o) => colorDistance(c, o) <= 2).length;
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  }
  return best;
}

/** How many rows of the strip read as a line against its own background. */
function lineRows(strip: Strip): number {
  const bg = modal(strip);
  return strip.rows.filter((c) => colorDistance(c, bg) >= VISIBLE).length;
}

await withBrowser(async (h) => {
  const r = report("control-panel hairlines");
  const { page } = await h.session({
    viewport: { width: 1600, height: 1000 },
  });

  await page.goto(url);
  await page.waitForTimeout(4000);
  // `noWaitAfter`: the sidebar nav click schedules a client-side route change
  // Playwright would wait on indefinitely; the pane render is what we wait for.
  await page
    .getByRole("button", { name: "Tasks", exact: true })
    .first()
    .click({ noWaitAfter: true });
  await page.waitForTimeout(2500);

  // Every trigger is icon-only, so its accessible name is the only handle on it;
  // an ACTIVE control spells its summary after a colon.
  const triggers = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button"))
      .map((b) => b.getAttribute("aria-label"))
      .filter(
        (l): l is string => !!l && /^(Filter|Sort|View settings)(:|$)/.test(l),
      ),
  );
  r.ok(
    "the Tasks toolbar exposes control triggers to open",
    triggers.length >= 2,
    triggers.join(" | "),
  );

  /** The blank strips a panel owes a verdict on: one per band boundary, plus the
   *  panel's own top pad (where the FIRST band's rule lands and must be
   *  cancelled — it has nothing above it to separate from). */
  const bandStrips = () =>
    page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".cp-panel.cp-body");
      if (!body) return null;
      const bands = Array.from(body.querySelectorAll<HTMLElement>(".cp-band"));
      if (bands.length === 0) return { bands: 0, strips: [] };
      const bodyTop = body.getBoundingClientRect().top;
      const strips = bands.map((band, i) => {
        const rc = band.getBoundingClientRect();
        const prev = i === 0 ? null : bands[i - 1]!.getBoundingClientRect();
        // Strictly the blank space above this band: the flex gap, or — for the
        // first band — the panel's own top pad. Never one pixel into a band, so
        // the strip can only ever contain background and the hairline.
        const top = prev ? prev.bottom : bodyTop;
        return {
          index: i,
          x: Math.round(rc.left + rc.width / 2),
          y: Math.round(top),
          height: Math.max(1, Math.round(rc.top - top)),
          text: band.innerText.replace(/\s+/g, " ").slice(0, 24),
        };
      });
      return { bands: bands.length, strips };
    });

  const sampleStrip = async (s: { x: number; y: number; height: number }) => {
    const grid = await samplePixels(page, {
      x: s.x - 2,
      y: s.y,
      width: 4,
      height: s.height,
    });
    const rows: Rgba[] = [];
    for (let dy = 0; dy < s.height; dy++) rows.push(grid.at(2, dy));
    return { rows };
  };

  for (const label of triggers) {
    const btn = page.getByRole("button", { name: label, exact: true }).first();
    if ((await btn.count()) === 0) continue;
    // `force`: the trigger sits under the DataView's sticky toolbar chrome.
    await btn.click({ force: true });
    await page.waitForTimeout(1200);
    await snap(page, out, label.replace(/\W+/g, "-").slice(0, 40));

    const found = await bandStrips();
    if (!found) {
      r.ok(`panel opens: ${label}`, false, "no control panel body on screen");
      continue;
    }
    r.ok(
      `panel is composed of bands: ${label}`,
      found.bands >= 1,
      `${found.bands} band(s)`,
    );

    for (const s of found.strips) {
      const strip = await sampleStrip(s);
      const n = lineRows(strip);
      const detail = `strip y=${s.y} h=${s.height}px → ${n} line row(s)`;
      if (s.index === 0) {
        // Nothing above it to separate from, so the panel cancels its rule.
        r.ok(`${label}: no rule above the first band`, n === 0, detail);
      } else {
        // Exactly one: a visible hairline, and only one of them.
        r.ok(
          `${label}: a visible hairline separates band ${s.index} ("${s.text}")`,
          n === 1,
          detail,
        );
      }
    }

    // ── Falsification ────────────────────────────────────────────────────
    // Paint the rule away and re-probe the SAME strips. If they still report a
    // line, this script is measuring something else and its passes above mean
    // nothing.
    // Injected by hand rather than through `addStyleTag`, whose handle is an
    // `ElementHandle<Node>` — and `Node` carries no `.remove()`, so tearing it
    // down again would need a cast. `createElement("style")` is typed all the
    // way through, and a verification script is the last place to hide a cast.
    const killId = "cp-hairline-falsify";
    await page.evaluate((id) => {
      const tag = document.createElement("style");
      tag.id = id;
      tag.textContent =
        ".cp-band::before { background: transparent !important; }";
      document.head.append(tag);
    }, killId);
    await page.waitForTimeout(250);
    let stillSeen = 0;
    for (const s of found.strips.filter((s) => s.index > 0))
      stillSeen += lineRows(await sampleStrip(s));
    r.ok(
      `${label}: the probe genuinely reads the hairline (falsification)`,
      stillSeen === 0 && found.strips.length > 1,
      found.strips.length > 1
        ? `${stillSeen} line row(s) survive painting the rule transparent`
        : "panel has a single band — nothing to falsify against",
    );
    await page.evaluate((id) => document.getElementById(id)?.remove(), killId);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  await r.finish();
});
