import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import {
  renderAppDeclarationsManifest,
  appDeclarationsManifestPath,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const check: Check = {
  id: "app-declarations-in-sync",
  description:
    "plugins/apps-core/server/internal/apps.generated.ts matches the apps the browser registers (Apps.App)",
  async run() {
    const root = await getWorktreeRoot();
    const file = appDeclarationsManifestPath(root);
    const rel = relative(root, file);
    if (!existsSync(file)) {
      return {
        ok: false,
        message: `${rel} is missing`,
        hint: "Run `./equin build` to generate it.",
      };
    }
    const expected = await formatGenerated({
      file,
      content: await renderAppDeclarationsManifest(root),
    });
    if (readFileSync(file, "utf8") !== expected) {
      return {
        ok: false,
        message: `${rel} is out of sync with the Apps.App contributions`,
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
