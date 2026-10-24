import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  regenerateRegistryCodegen,
  regenerateManifestCodegen,
  listReviewMarkedOverrides,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

const run: CliAction<[], object> = async () => {
  const root = await getWorktreeRoot();
  const { renamedPackages } = await regenerateRegistryCodegen({ root });
  await regenerateManifestCodegen({ root });

  // A corrected package name leaves `bun.lock` recording the old one. This
  // command does not install (it runs inside push's merge-driver path), so it
  // says so; the next `./equin` invocation's dependency check sees the
  // changed package.json and re-resolves the lockfile.
  if (renamedPackages.length > 0) {
    console.error(
      `Wrote the derived package name in:\n  ${renamedPackages.join("\n  ")}\n` +
        "bun.lock still records the old name(s) until dependencies are " +
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
