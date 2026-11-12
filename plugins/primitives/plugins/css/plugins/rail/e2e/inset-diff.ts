// Pairs the captures `inset-review.ts` (and `exhibit-shot.ts`) wrote and says,
// per pair, whether it is pixel-identical — and where it differs when not —
// so a review lists every surface as changed or identical from measurement,
// not from eyeballing.
//
//   ./equin run plugins/primitives/plugins/css/plugins/rail/e2e/inset-diff.ts \
//     --dir "$EQUIN_SCRATCH/inset-review"
//
// Pairs `<name>-before.png` / `<name>-after.png` and
// `ex-before-<id>.png` / `ex-after-<id>.png` in `--dir`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  arg,
  withBrowser,
  diffImages,
  heatmapText,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const dir = arg("dir", "/tmp/inset-review");

const pairs: { name: string; before: string; after: string }[] = [];
for (const f of readdirSync(dir).sort()) {
  const m = /^(.*)-before\.png$/.exec(f) ?? /^ex-before-(.*)\.png$/.exec(f);
  if (!m?.[1]) continue;
  const after = f.startsWith("ex-before-")
    ? `ex-after-${m[1]}.png`
    : `${m[1]}-after.png`;
  pairs.push({ name: m[1], before: `${dir}/${f}`, after: `${dir}/${after}` });
}

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 400, height: 300 } });
  for (const p of pairs) {
    if (!existsSync(p.after)) {
      console.log(`${p.name}: NO AFTER`);
      continue;
    }
    const after = readFileSync(p.after);
    const d = await diffImages(page, readFileSync(p.before), after, {
      threshold: 0.05,
      grid: { cols: 8, rows: 6 },
    });
    if (d.differing === 0 && d.sameSize) {
      console.log(`${p.name}: IDENTICAL`);
    } else {
      console.log(
        `${p.name}: CHANGED ${(d.ratio * 100).toFixed(2)}% (${d.differing}px)${d.sameSize ? "" : " size differs"}`,
      );
      console.log(heatmapText(d.grid));
    }
  }
});
