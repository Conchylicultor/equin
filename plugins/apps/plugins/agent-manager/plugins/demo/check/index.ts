import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  demoPrototypeDataOf,
  demoPrototypeSeed,
  demoVersionFingerprint,
  type DemoPrototypeData,
} from "../core";

/** The demo's `data/` folder off disk, as the seed reads it (the worker has it inlined). */
function diskDemoPrototypes(): DemoPrototypeData {
  const dir = join(import.meta.dir, "..", "data");
  const files: Record<string, Uint8Array> = {};
  for (const rel of readdirSync(dir, { recursive: true }) as string[])
    if (statSync(join(dir, rel)).isFile())
      files[rel.split(sep).join("/")] = new Uint8Array(
        readFileSync(join(dir, rel)),
      );
  return demoPrototypeDataOf(files);
}

const RENDER_COMMAND =
  "./equin run plugins/apps/plugins/agent-manager/plugins/demo/scripts/render-demo-thumbnails.ts";

/**
 * Every seeded prototype version has its committed thumbnail, and every
 * committed thumbnail is one a version names. The demo's browser host renders
 * nothing — its thumbnails are the PNGs in `data/thumbnails/`, named by the
 * folder fingerprint the gallery computes — so an edited seed file without a
 * re-render would show the card's "Preview unavailable" in the demo, and the
 * seed itself throws on it. Caught here, at build and push, with the command
 * that fixes it.
 */
const thumbnailsInSync: Check = {
  id: "demo:prototype-thumbnails-in-sync",
  description:
    "every prototype version the agent manager demo seeds has its thumbnail PNG committed beside the seed (named by its fingerprint), and no PNG there is unused",
  async run() {
    const data = diskDemoPrototypes();
    const { prototypes } = demoPrototypeSeed(data.tree);
    const wanted = new Set<string>();
    const missing: string[] = [];
    for (const p of prototypes)
      for (const v of p.versions) {
        const key = demoVersionFingerprint(v);
        wanted.add(key);
        if (data.thumbnails[key] === undefined)
          missing.push(`${p.id} v${v.n} (${key}.png)`);
      }
    const unused = Object.keys(data.thumbnails)
      .filter((key) => !wanted.has(key))
      .map((key) => `${key}.png`);
    if (missing.length === 0 && unused.length === 0) return { ok: true };
    return {
      ok: false,
      message: [
        ...missing.map((m) => `no thumbnail for ${m}`),
        ...unused.map((u) => `unused thumbnail ${u}`),
      ].join("\n    "),
      hint: `Re-render the demo's thumbnails: \`${RENDER_COMMAND}\` (renders the missing versions with the gallery's renderer and drops the unused PNGs).`,
    };
  },
};

export default [thumbnailsInSync];
