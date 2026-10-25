import { existsSync } from "fs";
import { readFile } from "fs/promises";
import {
  buildEnrichedTree,
  mainComposition,
  pluginClaudeMdPath,
  pluginCompactDocPath,
  pluginDetailsDocPath,
  pluginReferenceMdPath,
  renderCompactDoc,
  renderDetailsDoc,
  renderPluginClaudeMd,
  renderPluginReferenceMd,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/** A file's text, or null when it does not exist. */
async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const check: Check = {
  id: "plugins-doc-in-sync",
  description:
    "docs/plugins-compact.md, docs/plugins-details.md, every plugin's CLAUDE.md AUTOGEN block, and every plugin's REFERENCE.md (present exactly when a list is summarized) match the current plugin source",
  async run() {
    const root = await getWorktreeRoot();

    const compactFile = pluginCompactDocPath(root);
    if (!existsSync(compactFile)) {
      return {
        ok: false,
        message: "docs/plugins-compact.md is missing",
        hint: "Run `./equin build` to generate it.",
      };
    }
    const detailsFile = pluginDetailsDocPath(root);
    if (!existsSync(detailsFile)) {
      return {
        ok: false,
        message: "docs/plugins-details.md is missing",
        hint: "Run `./equin build` to generate it.",
      };
    }

    if (
      (await readFile(compactFile, "utf8")) !==
      (await formatGenerated({
        file: compactFile,
        content: await renderCompactDoc({ root }),
      }))
    ) {
      return {
        ok: false,
        message: "docs/plugins-compact.md is out of sync with plugin source",
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    if (
      (await readFile(detailsFile, "utf8")) !==
      (await formatGenerated({
        file: detailsFile,
        content: await renderDetailsDoc({ root }),
      }))
    ) {
      return {
        ok: false,
        message: "docs/plugins-details.md is out of sync with plugin source",
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }

    // The SAME inputs `generatePluginDocs` renders each CLAUDE.md from: the
    // enriched tree (memoized per root, so this is the very tree docgen used) and
    // the main composition resolved off it. The AUTOGEN block annotates
    // the plugins main's closure leaves out, so a check that computed membership
    // any other way would disagree with the generator it exists to check.
    const tree = await buildEnrichedTree(root);
    const main = mainComposition(tree, root);
    // One CLAUDE.md per plugin (~800): read each without blocking, and pause
    // every ~10 ms of rendering, so the loop never holds the check runner's
    // shared thread for the whole set.
    const slice = createTimeSlicer();
    for (const info of tree.byDir.values()) {
      await slice();
      const file = pluginClaudeMdPath(info);
      const existing = await readIfPresent(file);
      const expected = await formatGenerated({
        file,
        content: renderPluginClaudeMd(info, existing, root, tree.facets, main),
      });
      if (existing !== expected) {
        return {
          ok: false,
          message: `${file.replace(`${root}/`, "")} AUTOGEN block is out of sync with plugin source`,
          hint: "Run `./equin build` and commit the regenerated file.",
        };
      }

      const refFile = pluginReferenceMdPath(info);
      const reference = renderPluginReferenceMd(info, root, tree.facets);
      const refExisting = await readIfPresent(refFile);
      const refExpected =
        reference === null
          ? null
          : await formatGenerated({ file: refFile, content: reference });
      if (refExisting !== refExpected) {
        const rel = refFile.replace(`${root}/`, "");
        return {
          ok: false,
          message:
            refExpected === null
              ? `${rel} is stale: the plugin's CLAUDE.md summarizes no list`
              : refExisting === null
                ? `${rel} is missing`
                : `${rel} is out of sync with plugin source`,
          hint: "Run `./equin build` and commit the regenerated file.",
        };
      }
    }

    return { ok: true };
  },
};

export default check;
