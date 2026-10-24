/**
 * The artifacts row, measured where the complaint was made: in the deployed
 * app, against the real fonts.
 *
 * A user reported that the glyph and the title "are not aligned", and that the
 * title read too large. Both were true, and they were two different faults:
 *
 *   - the title had no declared size, so it inherited the document root (16px)
 *     in a panel whose own headings are 12px;
 *   - the truncating `<Text>` leaf was an `inline-block`, and an inline-level
 *     box whose overflow is hidden hands its line the bottom of its own margin
 *     box as a baseline — so the `<Fill>` cell around it still reserved room
 *     for the strut's descender underneath. The cell measured 30px for 24px of
 *     text, and the row's `items-center` dropped the glyph ~3px below the words.
 *
 * `layout-harness`'s `opticalCenter` invariant is what keeps the SECOND one
 * fixed, and it states the claim generically, on a synthetic row. This script
 * is the other half: it pins the claim on the real surface, with the real type
 * ramp, the real glyph and the real popover — the things a fixture stands in
 * for. A regression in either is worth knowing about separately.
 *
 * Optical centres, never box centres. A cell that is taller than its text
 * centres perfectly and still drops its siblings by half the extra height, so a
 * box-centre check is exactly the check that would have passed throughout.
 *
 * Manual only — nothing runs this. After `./equin build`:
 *
 *   ./equin run \
 *     plugins/conversations/plugins/conversation-view/plugins/artifacts/e2e/artifact-row-alignment.ts \
 *     [--conv <conversationId>] [--out <prefix>] [--headed]
 */
import {
  arg,
  boot,
  numArg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/**
 * A conversation with at least one row-shaped artifact. Overridable because the
 * default is a transcript on THIS machine; another checkout drives its own.
 */
const CONV = arg("conv", "conv-1789665798-etm3");
const out = arg("out", "/tmp/artifact-row-alignment");

/**
 * How far apart the glyph and the words may sit, in CSS pixels.
 *
 * Sub-pixel disagreement is the font rasteriser's, not the layout's: cap height
 * comes from `TextMetrics`, which reports fractional values. The bug this
 * guards against was 3.0px — forty times this — so the threshold does not need
 * to be delicate to be decisive.
 */
const TOLERANCE_PX = numArg("tolerance", 0.75);

/** The toolbar button, by the aria-label its three states share. */
const BUTTON = "Artifacts";

const r = report("artifact row alignment");

await withBrowser(async (h) => {
  const { page } = await h.session();
  const button = page.getByRole("button", { name: BUTTON, exact: true });

  await boot(page, pathUrl(`/agents/c/${CONV}`), {
    marker: `button[aria-label="${BUTTON}"]`,
  });

  // While the transcript is still arriving the button is a disabled glyph, and
  // it stays disabled when the conversation touched nothing — so enabled is
  // what "there is a panel to measure" looks like.
  const settled = await waitFor(
    async () => await button.isEnabled(),
    (enabled) => enabled,
    { timeoutMs: 60_000 },
  );
  if (!settled.ok) {
    r.note(
      `conversation ${CONV} lists no artifacts — pass --conv <id> for one that does`,
    );
    return;
  }

  await button.click();
  const panel = page.locator('[data-slot="popover-content"]');
  await panel.waitFor();
  // Two kinds resolve their titles from a live list and draw a skeleton until
  // it lands; measuring a skeleton would measure the wrong box.
  await waitFor(
    async () => await panel.locator("button svg").count(),
    (n) => n > 0,
    { timeoutMs: 30_000 },
  );
  await snap(page, out, "popover");

  const rows = await panel.evaluate((root: HTMLElement, tolerance: number) => {
    /**
     * The centre of a glyph's INK, not of its element. Material icons leave
     * clear space inside the viewBox, so the element's middle is a place the
     * eye never sees — and a check reading it would be reading the wrong thing.
     */
    function glyphInkCentre(svg: SVGGraphicsElement): number | null {
      const box = svg.getBoundingClientRect();
      const view = (svg as SVGSVGElement).viewBox?.baseVal;
      if (view === undefined || view.height === 0) return null;
      const ink = svg.getBBox();
      const scale = box.height / view.height;
      return box.top + (ink.y - view.y) * scale + (ink.height * scale) / 2;
    }

    /**
     * The middle of the letters — the midpoint of cap top and baseline. The
     * box's own middle is what `items-center` already agrees with, so it can
     * say nothing about whether the row looks right.
     */
    function textCapCentre(el: Element): number | null {
      const ctx = document.createElement("canvas").getContext("2d");
      if (ctx === null) return null;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`;
      const m = ctx.measureText(el.textContent ?? "");
      if (m.actualBoundingBoxAscent === 0) return null;
      const size = parseFloat(style.fontSize);
      const leading =
        style.lineHeight === "normal"
          ? size * 1.2
          : parseFloat(style.lineHeight);
      const baseline =
        box.top +
        (leading - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 +
        m.fontBoundingBoxAscent;
      return baseline - m.actualBoundingBoxAscent / 2;
    }

    const measured: {
      label: string;
      fontSize: string;
      rowHeight: number;
      cellHeight: number | null;
      textHeight: number;
      offset: number;
      aligned: boolean;
    }[] = [];

    for (const row of Array.from(root.querySelectorAll("button"))) {
      const svg = row.querySelector("svg");
      const words = Array.from(row.querySelectorAll("span")).find(
        (s) => (s.textContent ?? "").trim().length > 2,
      );
      if (svg === null || words === undefined) continue;
      const glyph = glyphInkCentre(svg as unknown as SVGGraphicsElement);
      const caps = textCapCentre(words);
      if (glyph === null || caps === null) continue;
      const offset = glyph - caps;
      measured.push({
        label: (words.textContent ?? "").slice(0, 40),
        fontSize: getComputedStyle(words).fontSize,
        rowHeight: row.getBoundingClientRect().height,
        cellHeight: words.parentElement?.getBoundingClientRect().height ?? null,
        textHeight: words.getBoundingClientRect().height,
        offset,
        aligned: Math.abs(offset) <= tolerance,
      });
    }
    return {
      rows: measured,
      panelFontSize: getComputedStyle(root).fontSize,
      headingFontSize:
        root.querySelector(".uppercase") === null
          ? null
          : getComputedStyle(root.querySelector(".uppercase")!).fontSize,
    };
  }, TOLERANCE_PX);

  r.ok(
    "the panel lists at least one row-shaped artifact",
    rows.rows.length > 0,
  );
  r.note(
    `panel ${rows.panelFontSize}, section headings ${rows.headingFontSize ?? "—"}`,
  );

  for (const row of rows.rows) {
    r.note(
      `"${row.label}" — ${row.fontSize}, row ${row.rowHeight}px, cell ${row.cellHeight}px over ${row.textHeight}px of text, glyph ${row.offset.toFixed(2)}px from the words`,
    );
    r.ok(
      `the glyph sits on the words in "${row.label}" (${row.offset.toFixed(2)}px, ≤ ${TOLERANCE_PX})`,
      row.aligned,
    );
    // The cell no longer carrying phantom space is the CAUSE; asserting it too
    // means a regression names itself instead of only showing up as a drift.
    r.ok(
      `the cell holding "${row.label}" is as tall as its text (${row.cellHeight}px vs ${row.textHeight}px)`,
      row.cellHeight !== null &&
        Math.abs(row.cellHeight - row.textHeight) <= TOLERANCE_PX,
    );
    // The title is a DECLARED size, not whatever the popover happened to hand
    // down. The root size is what a variant-less `<Text>` inherits here, which
    // is the shape of the original complaint.
    r.ok(
      `the title in "${row.label}" is not at the document root size (${row.fontSize})`,
      row.fontSize !== "16px",
    );
  }
});

await r.finish();
