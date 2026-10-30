// Reading a capture's assets dir back: `manifest.json` (a full capture),
// overlaid by every partial `manifest-<shots>.json` written after it (a
// re-capture of some shots wins). A partial that captured strip rects replaces
// them wholesale — its tiles do not line up with an older capture's.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AssetManifest } from "./assets";

export function loadManifest(dir: string): AssetManifest {
  if (!existsSync(dir))
    throw new Error(
      `film: assets dir ${dir} does not exist — run the capture first`,
    );
  const mtime = (f: string): number => statSync(join(dir, f)).mtimeMs;
  const all = readdirSync(dir).filter((f) => /^manifest(-.+)?\.json$/.test(f));
  const base = all.includes("manifest.json") ? mtime("manifest.json") : -1;
  const files = all
    .filter((f) => f === "manifest.json" || mtime(f) > base)
    .sort((a, b) => mtime(a) - mtime(b));
  if (!files.length)
    throw new Error(
      `film: no manifest*.json in ${dir} — run the capture first`,
    );
  let out: AssetManifest | null = null;
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as AssetManifest;
    if (out === null) {
      out = m;
      continue;
    }
    out = {
      ...out,
      dpr: m.dpr,
      width: m.width,
      height: m.height,
      stills: { ...out.stills, ...m.stills },
      rects: { ...out.rects, ...m.rects },
      sequences: { ...out.sequences, ...m.sequences },
      strips: { ...out.strips, ...m.strips },
      stripRects: Object.keys(m.stripRects).length
        ? { ...m.stripRects }
        : out.stripRects,
      audio: { ...out.audio, ...m.audio },
    };
  }
  if (out === null) throw new Error("film: unreachable — no manifest read");
  const need = [
    ...Object.values(out.stills).map((s) => s.file),
    ...Object.values(out.sequences).flatMap((s) => s.frames),
    ...Object.values(out.audio).map((a) => a.file),
  ];
  for (const file of need) {
    if (!existsSync(join(dir, file)))
      throw new Error(
        `film: the manifest names ${file}, which is not in ${dir}`,
      );
  }
  for (const [name, st] of Object.entries(out.strips)) {
    for (const tile of st.tiles) {
      if (!out.stills[tile])
        throw new Error(
          `film: strip "${name}" names tile "${tile}", which is not a still`,
        );
    }
  }
  return out;
}
