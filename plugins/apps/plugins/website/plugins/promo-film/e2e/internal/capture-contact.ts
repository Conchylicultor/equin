// A contact sheet of every still in the assets dir, for quick review: a few
// Read-able PNGs in /tmp/equin-film/contact/.

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { type Ctx, ensureDir } from "./capture-kit";

const CONTACT = "/tmp/equin-film/contact";
const PER_SHEET = 12;

export async function contactSheet(c: Ctx, page: Page): Promise<void> {
  ensureDir(CONTACT);
  const files = readdirSync(c.out)
    .filter(
      (f) =>
        f.endsWith(".png") &&
        !/-t\d\d\.png$/.test(f) &&
        !/^sonata-play-/.test(f) &&
        !/-icon\.png$/.test(f) &&
        !/^tile-/.test(f) &&
        !/^iceberg(-collapsed)?-\d\d\.png$/.test(f),
    )
    .sort();
  // A sequence is shown by its first, middle and last frame.
  const seqs = Object.entries(c.manifest.sequences).flatMap(([, s]) => [
    s.frames[0]!,
    s.frames[Math.floor(s.frames.length / 2)]!,
    s.frames.at(-1)!,
  ]);
  const extra = readdirSync(c.out)
    .filter((f) => /^tile-.*\.png$/.test(f) && !/-icon\.png$/.test(f))
    .slice(0, 8);
  const all = [
    ...files,
    ...seqs,
    ...extra,
    ...readdirSync(c.out).filter((f) => /^iceberg-0[0-3]\.png$/.test(f)),
  ];
  const sheets = Math.ceil(all.length / PER_SHEET);
  const pg = await c.context.newPage();
  await pg.setViewportSize({ width: 1800, height: 1300 });
  for (let s = 0; s < sheets; s++) {
    const chunk = all.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const html = `<body style="margin:0;background:#222;color:#ddd;font:12px sans-serif;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px">${chunk
      .map(
        (f) =>
          `<figure style="margin:0"><img src="file://${join(c.out, f)}" style="width:100%;max-height:380px;object-fit:contain;background:#444"><figcaption>${f}</figcaption></figure>`,
      )
      .join("")}</body>`;
    const path = join(CONTACT, `sheet-${s}.html`);
    writeFileSync(path, html);
    await pg.goto(`file://${path}`);
    await pg.waitForLoadState("load");
    await pg.screenshot({
      path: join(CONTACT, `sheet-${s}.png`),
      fullPage: true,
    });
  }
  await pg.close();
  void page;
  console.log(`contact sheets: ${sheets} in ${CONTACT}`);
}
