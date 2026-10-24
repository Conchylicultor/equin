import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import {
  renderFieldsEagerManifest,
  fieldsEagerManifestPath,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const check: Check = {
  id: "fields-eager-in-sync",
  description:
    "plugins/fields/plugins/server-capabilities-loader/server/internal/eager.generated.ts matches the current fields storage server barrels",
  async run() {
    const root = await getWorktreeRoot();
    const file = fieldsEagerManifestPath(root);
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
      content: await renderFieldsEagerManifest(root),
    });
    if (readFileSync(file, "utf8") !== expected) {
      return {
        ok: false,
        message: `${rel} is out of sync with the fields storage server barrels`,
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
