import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import {
  companionManifestPath,
  formatGenerated,
  renderCompanionManifest,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * The web-sdk's companion manifest states the companions the code declares.
 * The runtime reads it to tell a legitimate fallback from a missing companion,
 * so a stale copy would either miss a gap or cry wolf.
 */
export const companionsInSync: Check = {
  id: "companions-in-sync",
  description:
    "plugins/framework/plugins/web-sdk/core/companions.generated.ts matches the companion slots and contributions the code declares",
  async run() {
    const root = await getWorktreeRoot();
    const file = companionManifestPath(root);
    const rel = relative(root, file);
    if (!existsSync(file))
      return {
        ok: false,
        message: `${rel} is missing`,
        hint: "Run `./singularity build` to generate it.",
      };
    const expected = await formatGenerated({
      file,
      content: await renderCompanionManifest(root),
    });
    if (readFileSync(file, "utf8") !== expected)
      return {
        ok: false,
        message: `${rel} is out of sync with the companion slots and contributions`,
        hint: "Run `./singularity build` and commit the regenerated file.",
      };
    return { ok: true };
  },
};
