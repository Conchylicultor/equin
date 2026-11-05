import type { CheckContext } from "@plugins/framework/plugins/tooling/core";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { relative } from "path";
import {
  renderFieldsEagerManifest,
  fieldsEagerManifestPath,
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
  id: "fields-eager-in-sync",
  description:
    "plugins/fields/plugins/server-capabilities-loader/server/internal/eager.generated.ts matches the current fields storage server barrels",
  async run(ctx) {
    const pass = codegenPassOver(await ctx.repo());
    const root = pass.root;
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
      content: await renderFieldsEagerManifest(pass),
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
