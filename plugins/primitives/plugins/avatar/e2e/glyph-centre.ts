/**
 * Is an avatar's fallback letter centred in its disc? Measures the RENDERED
 * ink of the capital (a 4× capture of each disc, every pixel far from the
 * disc's fill) against the disc's centre, for a few letters at the `sm` and `md` sizes in
 * the `badge` (medium) and `solid-badge` (bold) weights.
 *
 * The test discs are clones of a real avatar on the agent manager page (the
 * sidebar foot's account avatar), restyled to each size and weight with the
 * classes the Avatar primitive itself emits, so the measurement runs on the
 * app's own CSS and font.
 *
 * Manual only. After `./equin build`:
 *
 *   ./equin run plugins/primitives/plugins/avatar/e2e/glyph-centre.ts [--max-offset 0.5] [--out /tmp/glyphs]
 */
import {
  arg,
  numArg,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const maxOffset = numArg("max-offset", 0.5);
const out = arg("out", "/tmp/avatar-glyph-centre");
const r = report("avatar-glyph-centre");

const CASES = {
  letters: ["T", "E", "C", "W"],
  sizes: {
    sm: { box: "size-avatar-sm", glyph: "text-[length:50cqh]" },
    md: { box: "size-avatar-md", glyph: "text-[length:43.75cqh]" },
  },
  weights: { badge: "font-medium", "solid-badge": "font-bold" },
};

/** Rendering scale of the capture, so sub-pixel offsets are visible. */
const SCALE = 4;

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: SCALE,
  });
  await page.goto(pathUrl("/agents"));
  const sourceSel = 'button[aria-label="Claude account"] [data-avatar]';
  await page.locator(sourceSel).waitFor();
  // Clone the real avatar once per case into a fixed stage, restyled with
  // the primitive's own size and weight classes.
  const keys = await page.evaluate(
    ({ cases, sourceSel }) => {
      const source = document.querySelector(sourceSel);
      if (!source) throw new Error("no avatar on the page");
      const stage = document.createElement("div");
      stage.id = "glyph-stage";
      stage.style.cssText =
        "position:fixed;left:20px;top:20px;display:flex;flex-wrap:wrap;gap:12px;width:600px;z-index:99999";
      document.body.append(stage);
      const out: string[] = [];
      for (const [sizeName, size] of Object.entries(cases.sizes)) {
        for (const [presentation, weight] of Object.entries(cases.weights)) {
          for (const letter of cases.letters) {
            const disc = source.cloneNode(true) as HTMLElement;
            disc.className = disc.className.replace(
              /\bsize-avatar-[a-z]+\b/,
              size.box,
            );
            const glyph = disc.querySelector("span")!;
            glyph.className = glyph.className
              .replace(/font-(medium|bold)/, weight)
              .replace(/text-\[length:[^\]]+\]/, size.glyph);
            glyph.textContent = letter;
            const key = `${sizeName} ${presentation} ${letter}`;
            disc.dataset.case = key;
            stage.append(disc);
            out.push(key);
          }
        }
      }
      return out;
    },
    { cases: CASES, sourceSel },
  );
  const stagePath = `${out}-discs.png`;
  await page.locator("#glyph-stage").screenshot({ path: stagePath });
  console.log(`wrote ${stagePath} (${SCALE}× scale)`);
  for (const key of keys) {
    const disc = page.locator(`#glyph-stage [data-case="${key}"]`);
    const box = await disc.boundingBox();
    if (!box) throw new Error(`no box for ${key}`);
    const png = (await disc.screenshot()).toString("base64");
    // The rendered ink: every pixel inside the disc far from the disc's own
    // fill (sampled just inside its left edge, on the centre line).
    const ink = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      const at = (x: number, y: number): [number, number, number] => {
        const i = (y * width + x) * 4;
        return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
      };
      const fill = at(Math.round(width * 0.18), Math.round(height / 2));
      const r = width / 2;
      let x0 = width,
        x1 = -1,
        y0 = height,
        y1 = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if ((x - r) ** 2 + (y - r) ** 2 > (r * 0.8) ** 2) continue;
          const p = at(x, y);
          const d =
            Math.abs(p[0] - fill[0]) +
            Math.abs(p[1] - fill[1]) +
            Math.abs(p[2] - fill[2]);
          if (d < 120) continue;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
      return { x0, x1, y0, y1, width, height };
    }, png);
    const dx = ((ink.x0 + ink.x1 + 1) / 2 - ink.width / 2) / SCALE;
    const dy = ((ink.y0 + ink.y1 + 1) / 2 - ink.height / 2) / SCALE;
    r.ok(
      `${key} (${box.width}px disc): ink centre off the disc centre by dx ${dx.toFixed(2)}px, dy ${dy.toFixed(2)}px`,
      Math.abs(dx) <= maxOffset && Math.abs(dy) <= maxOffset,
    );
  }
  await r.finish();
});
