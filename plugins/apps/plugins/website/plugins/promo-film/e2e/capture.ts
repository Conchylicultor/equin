// Captures the showcase film's assets: layered stills of the REAL app at 2x
// DPR, plus the rect of every element the composition animates, the stepped
// typing sequences, the timed Sonata sequence and its sound.
//
// Staging is UI-only interaction and DOM injection against main (which refuses
// agent writes): nothing is submitted. What is injected is listed in the
// capture report next to each shot (conversation chip on the wiki page,
// opening hours under the place cards, a documentation-range server address).
//
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/capture.ts \
//     --url http://equin.localhost:9000 [--only home,chain,sonata,audio,deploy,places,create,circle,desktop,mac,iceberg] \
//     [--out /tmp/equin-film/assets]
//
// Writes `<out>/*.png`, `manifest.json` (a full run) or `manifest-<shots>.json` (a partial one),
// and a contact sheet to /tmp/equin-film/contact/.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  arg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  DPR,
  ensureDir,
  H,
  newManifest,
  W,
  type Ctx,
} from "./internal/capture-kit";
import { chainShots, homeShot } from "./internal/capture-home-chain";
import {
  sonataAudio,
  sonataSequence,
  sonataStill,
} from "./internal/capture-sonata";
import {
  createShots,
  deployShot,
  placesShots,
} from "./internal/capture-places";
import {
  circleShots,
  desktopShots,
  icebergShots,
  macShots,
} from "./internal/capture-more";
import { contactSheet } from "./internal/capture-contact";

const OUT = arg("out", "/tmp/equin-film/assets")!;
const ONLY = arg("only")?.split(",");
const SHOTS: Record<string, (c: Ctx) => Promise<void>> = {
  home: homeShot,
  chain: chainShots,
  sonata: async (c) => {
    await sonataStill(c);
    await sonataSequence(c);
  },
  audio: sonataAudio,
  deploy: deployShot,
  places: placesShots,
  create: createShots,
  circle: circleShots,
  desktop: desktopShots,
  mac: macShots,
  iceberg: icebergShots,
};
for (const k of ONLY ?? [])
  if (!SHOTS[k])
    throw new Error(
      `unknown shot "${k}"; known: ${Object.keys(SHOTS).join(", ")}`,
    );

ensureDir(OUT);
await withBrowser(async (h) => {
  const { page, context } = await h.session({
    viewport: { width: W, height: H },
    deviceScaleFactor: DPR,
    colorScheme: "dark",
  });
  const c: Ctx = { context, page, out: OUT, manifest: newManifest() };
  for (const [name, run] of Object.entries(SHOTS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log(name);
    await run(c);
  }
  // One manifest.json, whatever was run: this run's groups merged over what the assets dir already holds
  // (older partial manifest-<shots>.json files from earlier runs are folded in, oldest first, then removed).
  const merged = newManifest();
  const parts = readdirSync(OUT)
    .filter((f) => /^manifest(-.+)?\.json$/.test(f))
    .sort(
      (x, y) => statSync(join(OUT, x)).mtimeMs - statSync(join(OUT, y)).mtimeMs,
    );
  for (const f of [...parts, null]) {
    const m =
      f === null
        ? c.manifest
        : (JSON.parse(readFileSync(join(OUT, f), "utf8")) as typeof c.manifest);
    Object.assign(merged.stills, m.stills);
    Object.assign(merged.rects, m.rects);
    Object.assign(merged.sequences, m.sequences);
    Object.assign(merged.strips, m.strips);
    Object.assign(merged.stripRects, m.stripRects);
    Object.assign(merged.audio, m.audio);
  }
  for (const f of parts)
    if (f !== "manifest.json" && existsSync(join(OUT, f)))
      unlinkSync(join(OUT, f));
  const file = "manifest.json";
  writeFileSync(join(OUT, file), JSON.stringify(merged, null, 2));
  console.log(
    `wrote ${Object.keys(merged.stills).length} stills, ${Object.keys(merged.rects).length} rects, ${Object.keys(merged.sequences).length} sequences -> ${join(OUT, file)}`,
  );
  c.manifest = merged;
  await contactSheet(c, page);
});
