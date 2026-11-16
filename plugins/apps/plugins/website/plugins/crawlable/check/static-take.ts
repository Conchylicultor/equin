import type { Check } from "@plugins/framework/plugins/tooling/core";
import { takeCrawlSnapshot } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/core";
import { readCompositionManifestsFromDisk } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Every crawlable composition's static take succeeds on this tree: each page
 * the composition declares renders, through the real app, to a document with
 * text — the same take `./equin build --composition <c>` runs, at the same
 * address (`takeCrawlSnapshot`).
 *
 * Without it a page that cannot render statically — a layout's provider the
 * renderer did not mount, a page that draws only a picture — passed every
 * check and failed only the composition's next build, a deploy later
 * (`build-1794814782-2rkiu7`). The snapshot is content-addressed over
 * everything the take reads, so an unchanged address is a store hit (no take);
 * a take that passes is published, and the next build of the tree reuses it.
 * A cold take is ~2 s.
 */
export const staticTakeCheck: Check = {
  id: "crawlable:static-take",
  description:
    "every crawlable composition's pages render statically (the crawl snapshot's take succeeds)",
  async run(ctx) {
    const root = asAppPath(REPO_ROOT);
    const crawlable = readCompositionManifestsFromDisk(root)
      .filter((m) => m.crawlable)
      .map((m) => m.id);
    const snapshot = await ctx.repo();
    const failures: string[] = [];
    for (const composition of crawlable) {
      try {
        const { took, dirName } = await takeCrawlSnapshot({
          root,
          snapshot,
          composition,
          log: (line) => ctx.log?.(line, "stdout"),
        });
        ctx.log?.(
          `crawl snapshot ${composition}: ${took ? "taken" : "cache hit"} (${dirName})`,
          "stdout",
        );
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        failures.push(err.message);
      }
    }
    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: failures.join("\n\n"),
      hint: "A page of a crawlable composition fails its static render (the error names the page, the path and the component path). See plugins/primitives/plugins/dom/plugins/static-render/CLAUDE.md for what a static render mounts and what it leaves out.",
    };
  },
};
