import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { prototypeMetasIn } from "@plugins/apps/plugins/prototypes/plugins/files/cli";
import { relPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { diskDirMount } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import { fingerprintFolder } from "../server/internal/hash-dir";
import { renderThumbnail } from "../machine/internal/render";

/**
 * `./equin prototype thumbnails <tree> --out <dir>` — render the gallery
 * picture of every prototype folder under `<tree>` with the gallery's own
 * renderer (the same Chromium, viewport and density as the render job), each
 * written to `<dir>/<fingerprint>.png`: the name the thumbnail cache looks it
 * up by, so the PNGs can be put into any host's cache and hit. A folder whose
 * PNG is already there is skipped (the name is its content). Installs Chromium
 * on first use.
 *
 * For a tree that is not the data dir — a demo's seeded prototypes, laid out
 * in a temp dir per version — whose pictures are committed beside the seed
 * because the browser host they are shown in cannot render.
 */
export const renderThumbnailsAction: CliAction<
  [string],
  { out: string }
> = async (treeArg, opts) => {
  const tree = resolve(treeArg);
  const out = resolve(opts.out);
  if (!existsSync(tree)) throw new Error(`no such prototypes tree: ${tree}`);
  const mount = diskDirMount(tree);
  const metas = await prototypeMetasIn(mount);
  if (metas.length === 0)
    throw new Error(`${tree} holds no prototype folder to render`);
  mkdirSync(out, { recursive: true });
  const installed = await ensureDep(chromium, cliExecContext(), {
    log: (line) => console.error(line),
  });
  for (const meta of metas) {
    const fingerprint = await fingerprintFolder(mount, relPath(meta.name));
    if (fingerprint.kind !== "hashed")
      throw new Error(`${meta.name} vanished from ${tree} while rendering`);
    const file = join(out, `${fingerprint.key}.png`);
    if (existsSync(file)) {
      console.log(`${meta.name}: ${fingerprint.key}.png (already rendered)`);
      continue;
    }
    const png = await renderThumbnail(meta, join(tree, meta.name), installed);
    writeFileSync(file, png);
    console.log(
      `${meta.name}: ${fingerprint.key}.png (${png.byteLength} bytes)`,
    );
  }
};
