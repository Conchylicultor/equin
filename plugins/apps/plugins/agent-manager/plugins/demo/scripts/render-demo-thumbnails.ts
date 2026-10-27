// Renders the agent manager demo's prototype thumbnails — every version of
// every seeded prototype — with the gallery's own renderer, into
// `data/thumbnails/<fingerprint>.png`, and drops the PNGs no version names. The
// demo's browser host cannot render (no Chromium in a page), so its pictures
// are committed beside the seed; `demo:prototype-thumbnails-in-sync` fails
// the build until this is re-run after a seed edit.
//
// Run: `./equin run plugins/apps/plugins/agent-manager/plugins/demo/scripts/render-demo-thumbnails.ts`
//
// Each version's folder is laid out in a temp tree (one folder per version,
// named `<id>.v<N>` — the renderer reads a folder, the fingerprint its files,
// never its name), then `./equin prototype thumbnails` renders the tree.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
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

const DEMO_THUMBNAILS_DIR = join(import.meta.dir, "..", "data", "thumbnails");

const data = diskDemoPrototypes();
const { prototypes } = demoPrototypeSeed(data.tree);
const tree = mkdtempSync(join(tmpdir(), "demo-thumbnails-"));
const wanted = new Set<string>();
try {
  for (const p of prototypes)
    for (const v of p.versions) {
      wanted.add(demoVersionFingerprint(v));
      const folder = join(tree, `${p.id}.v${v.n}`);
      mkdirSync(folder);
      for (const [name, text] of Object.entries(v.files))
        writeFileSync(join(folder, name), text);
    }
  const child = Bun.spawnSync(
    [
      join(REPO_ROOT, "equin"),
      "prototype",
      "thumbnails",
      tree,
      "--out",
      DEMO_THUMBNAILS_DIR,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (child.exitCode !== 0)
    throw new Error(`./equin prototype thumbnails exited ${child.exitCode}`);
} finally {
  rmSync(tree, { recursive: true, force: true });
}
for (const key of Object.keys(diskDemoPrototypes().thumbnails))
  if (!wanted.has(key)) {
    rmSync(join(DEMO_THUMBNAILS_DIR, `${key}.png`));
    console.log(`dropped unused ${key}.png`);
  }
console.log(
  `${wanted.size} thumbnails for ${prototypes.length} prototypes in ${DEMO_THUMBNAILS_DIR}`,
);
