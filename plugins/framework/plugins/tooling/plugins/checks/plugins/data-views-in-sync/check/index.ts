import type { CheckContext } from "@plugins/framework/plugins/tooling/core";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { relative } from "path";
import {
  renderDataViewsManifest,
  dataViewsManifestPath,
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
  id: "data-views-in-sync",
  description:
    "plugins/primitives/plugins/data-view/shared/data-views.generated.ts matches the current defineDataView ids",
  async run(ctx) {
    const pass = codegenPassOver(await ctx.repo());
    const root = pass.root;
    const file = dataViewsManifestPath(root);
    const rel = relative(root, file);
    if (!existsSync(file)) {
      return {
        ok: false,
        message: `${rel} is missing`,
        hint: "Run `./equin build` to generate it.",
      };
    }
    // The renderer THROWS on a `defineDataView` id it cannot resolve from source.
    // That is a real finding about the tree, not a bug in the check — report it as
    // this check's own failure so the runner prints the file/line, instead of
    // aborting the whole run with a stack trace.
    let expected: string;
    try {
      expected = await formatGenerated({
        file,
        content: await renderDataViewsManifest(pass),
      });
    } catch (err) {
      return {
        ok: false,
        message: `${rel} could not be regenerated: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Fix the marker call named above, then run `./equin build`.",
      };
    }
    if (readFileSync(file, "utf8") !== expected) {
      return {
        ok: false,
        message: `${rel} is out of sync with the defineDataView ids`,
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
