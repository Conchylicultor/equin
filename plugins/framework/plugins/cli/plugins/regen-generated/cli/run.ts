import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  regenerateRegistryCodegen,
  regenerateManifestCodegen,
  listReviewMarkedOverrides,
  writingCodegenPass,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { installRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";

const run: CliAction<[], object> = async () => {
  const root = await getWorktreeRoot();
  // The shared plugin records, as the build reads them: the facets and
  // evaluated barrels of the plugins this push did not touch are not computed
  // again.
  installRecordStore(openRecordStore());
  // One pass for both pipelines: the trees read the first snapshot, and each
  // barrel-evaluation phase re-takes it after the previous phase's writes.
  const pass = writingCodegenPass(await loadRepoSnapshot(root), () =>
    loadRepoSnapshot(root),
  );
  const { renamedPackages } = await regenerateRegistryCodegen({ pass });
  await regenerateManifestCodegen({ pass });

  // A created or corrected package.json leaves `bun.lock` without the new
  // member, or recording its old name. This
  // command does not install (it runs inside push's merge-driver path), so it
  // says so; the next `./equin` invocation's dependency check sees the
  // changed package.json and re-resolves the lockfile.
  if (renamedPackages.length > 0) {
    console.error(
      `Wrote the derived package name in (new or renamed workspace members):\n  ${renamedPackages.join("\n  ")}\n` +
        "bun.lock does not record them until dependencies are " +
        "re-resolved — `./equin build` does it.",
    );
  }

  // This command runs inside push's merge-driver path, which is followed by
  // `git add -A && git commit --amend`. A config override still carrying an
  // `@review` marker is a machine-seeded / re-stamped default nobody has
  // reviewed — amending it would land exactly what the marker exists to
  // prevent. So the marker is asserted absent HERE rather than trusted to a
  // check ordering. (Markers are minted by `./equin build` only; this
  // pipeline never creates one — see codegen's regen-pipeline.ts.)
  const marked = listReviewMarkedOverrides({ root });
  if (marked.length > 0) {
    console.error(
      `An @review marker reached a post-commit tree:\n  ${marked
        .map((rel) => `config/${rel}`)
        .join("\n  ")}\n` +
        "These overrides were machine-seeded and are not yet reviewed. Run " +
        "`./equin build` locally, review each file (arrange the values, " +
        "then delete its `// @review` line), and commit it.",
    );
    process.exit(1);
  }
};

export default run;
