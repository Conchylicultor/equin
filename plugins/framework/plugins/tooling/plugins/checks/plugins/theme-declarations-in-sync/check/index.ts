import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import {
  renderThemeDeclarationsManifest,
  themeDeclarationsManifestPath,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const check: Check = {
  id: "theme-declarations-in-sync",
  description:
    "plugins/ui/plugins/theme-engine/server/internal/theme-declarations.generated.ts matches the token groups, themes and apps the browser registers",
  async run() {
    const root = await getWorktreeRoot();
    const file = themeDeclarationsManifestPath(root);
    const rel = relative(root, file);
    if (!existsSync(file)) {
      return {
        ok: false,
        message: `${rel} is missing`,
        hint: "Run `./singularity build` to generate it.",
      };
    }
    const expected = await formatGenerated({
      file,
      content: await renderThemeDeclarationsManifest(root),
    });
    if (readFileSync(file, "utf8") !== expected) {
      return {
        ok: false,
        message: `${rel} is out of sync with the theme contributions`,
        hint: "Run `./singularity build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
