import { relative } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import {
  auditPrototypeFixtureThumbnails,
  parsePrototypeTree,
} from "../../core";
import { readPrototypeFixtureDir } from "./disk";

/** The script that renders a fixture's thumbnails, from the repo root. */
const RENDER_SCRIPT =
  "plugins/apps/plugins/prototypes/plugins/fixtures/scripts/render-fixture-thumbnails.ts";

/** The command that re-renders the thumbnails of the fixture at `dir`. */
export function renderFixtureThumbnailsCommand(dir: string): string {
  return `./equin run ${RENDER_SCRIPT} --fixture ${relative(REPO_ROOT, dir)}`;
}

/**
 * The check that every version of the fixture at `dir` (a directory holding
 * `prototypes/` and `thumbnails/`) has its thumbnail PNG committed, named by
 * the folder fingerprint the gallery computes, and that no PNG there is
 * unused — for the `check/index.ts` of whichever plugin owns the fixture:
 *
 * ```ts
 * export default [
 *   prototypeFixtureThumbnailsCheck({
 *     id: "<plugin>:prototype-thumbnails-in-sync",
 *     dir: join(import.meta.dir, "..", "data"),
 *   }),
 * ];
 * ```
 *
 * A host with no renderer (a browser host) shows only those PNGs, so an
 * edited fixture file without a re-render would show "Preview unavailable" —
 * and `writePrototypeFixture` refuses it. Caught here, at build and push, with
 * the command that fixes it.
 */
export function prototypeFixtureThumbnailsCheck(opts: {
  id: string;
  dir: string;
}): Check {
  const where = relative(REPO_ROOT, opts.dir);
  return {
    id: opts.id,
    description: `every prototype version of the fixture in ${where} has its thumbnail PNG committed beside it (named by its fingerprint), and no PNG there is unused`,
    async run() {
      const data = readPrototypeFixtureDir(opts.dir);
      const { missing, unused } = auditPrototypeFixtureThumbnails(
        parsePrototypeTree(data.tree),
        data.thumbnails,
      );
      if (missing.length === 0 && unused.length === 0) return { ok: true };
      return {
        ok: false,
        message: [
          ...missing.map((m) => `no thumbnail for ${m}`),
          ...unused.map((u) => `unused thumbnail ${u}`),
        ].join("\n    "),
        hint: `Re-render the fixture's thumbnails: \`${renderFixtureThumbnailsCommand(opts.dir)}\` (renders every version with the gallery's renderer and drops the unused PNGs).`,
      };
    },
  };
}
