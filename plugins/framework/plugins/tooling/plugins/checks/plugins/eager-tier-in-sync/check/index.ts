import { relative } from "path";
import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";
import {
  buildRegistryGenContext,
  renderEagerTierManifest,
  eagerTierManifestPath,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";

const check: Check = {
  id: "eager-tier-in-sync",
  description:
    "plugins/framework/plugins/web-sdk/core/web-tiers.generated.ts matches the current derived load tiers (structural + watched-slot + preload + dependsOn closure)",
  async run(checkCtx: CheckContext) {
    const repo = await checkCtx.repo();
    const { root } = repo;
    const file = eagerTierManifestPath(root);
    const rel = relative(root, file);
    const actual = await repo.read(rel);
    if (actual === null) {
      return {
        ok: false,
        message: `${rel} is missing`,
        hint: "Run `./equin build` to generate it.",
      };
    }
    // Rendering may throw the reachability guard (a preloaded descriptor whose
    // owning plugin has no web entry). Surface it as a check failure with the fix,
    // not a crash, so push/build reports it cleanly.
    let expected: string;
    try {
      expected = await renderEagerTierManifest(
        root,
        await buildRegistryGenContext(root, repo),
      );
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : `Failed to derive load tiers: ${String(err)}`,
        hint: "A boot-critical resource descriptor is unreachable — see the message.",
      };
    }
    if (actual !== (await formatGenerated({ file, content: expected }))) {
      return {
        ok: false,
        message: `${rel} is out of sync with the derived load tiers`,
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
