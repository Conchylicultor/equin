import type { CheckContext } from "@plugins/framework/plugins/tooling/core";

import {
  buildEnrichedTree,
  firstStalePluginDoc,
  mainComposition,
  pluginCompactDocPath,
  pluginDetailsDocPath,
  renderCompactDoc,
  renderDetailsDoc,
  formatGenerated,
  codegenPassOver,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(ctx: CheckContext): Promise<CheckResult>;
};

const check: Check = {
  id: "plugins-doc-in-sync",
  description:
    "docs/plugins-compact.md, docs/plugins-details.md, every plugin's CLAUDE.md AUTOGEN block, and every plugin's REFERENCE.md (present exactly when a list is summarized) match the current plugin source",
  async run(ctx) {
    const repo = await ctx.repo();
    const pass = codegenPassOver(repo);
    const root = pass.root;
    // Which files exist is the run's file set's answer, never a stat; a
    // member's text is read through it.
    const relOf = (file: string): string => file.replace(`${root}/`, "");
    const readIfPresent = (file: string): Promise<string | null> =>
      repo.has(relOf(file)) ? repo.read(relOf(file)) : Promise.resolve(null);

    const compactFile = pluginCompactDocPath(root);
    if (!repo.has(relOf(compactFile))) {
      return {
        ok: false,
        message: "docs/plugins-compact.md is missing",
        hint: "Run `./equin build` to generate it.",
      };
    }
    const detailsFile = pluginDetailsDocPath(root);
    if (!repo.has(relOf(detailsFile))) {
      return {
        ok: false,
        message: "docs/plugins-details.md is missing",
        hint: "Run `./equin build` to generate it.",
      };
    }

    if (
      (await readIfPresent(compactFile)) !==
      (await formatGenerated({
        file: compactFile,
        content: await renderCompactDoc({ pass }),
      }))
    ) {
      return {
        ok: false,
        message: "docs/plugins-compact.md is out of sync with plugin source",
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    if (
      (await readIfPresent(detailsFile)) !==
      (await formatGenerated({
        file: detailsFile,
        content: await renderDetailsDoc({ pass }),
      }))
    ) {
      return {
        ok: false,
        message: "docs/plugins-details.md is out of sync with plugin source",
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }

    // The SAME inputs `generatePluginDocs` renders each CLAUDE.md from: the
    // enriched tree (memoized per pass, so this is the very tree docgen used) and
    // the main composition resolved off it. The AUTOGEN block annotates
    // the plugins main's closure leaves out, so a check that computed membership
    // any other way would disagree with the generator it exists to check.
    const tree = await buildEnrichedTree(pass);
    const main = mainComposition(tree, root);
    // Each CLAUDE.md is judged from a fold record of its bytes (the block it
    // already holds) and each REFERENCE.md by blob id — the verdict of
    // re-rendering the file whole, reading only what an edit touched.
    const stale = await firstStalePluginDoc(tree, repo, main);
    if (stale !== null) {
      return {
        ok: false,
        message: stale.message,
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }

    return { ok: true };
  },
};

export default check;
