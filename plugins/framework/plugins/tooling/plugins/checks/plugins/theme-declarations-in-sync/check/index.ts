import type { CheckContext } from "@plugins/framework/plugins/tooling/core";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { relative } from "path";
import {
  renderThemeDeclarationsManifest,
  themeDeclarationsManifestPath,
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
  id: "theme-declarations-in-sync",
  description:
    "plugins/ui/plugins/theme-engine/server/internal/theme-declarations.generated.ts matches the token groups and themes the browser registers",
  async run(ctx) {
    const pass = codegenPassOver(await ctx.repo());
    const root = pass.root;
    const file = themeDeclarationsManifestPath(root);
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
      content: await renderThemeDeclarationsManifest(pass),
    });
    if (readFileSync(file, "utf8") !== expected) {
      return {
        ok: false,
        message: `${rel} is out of sync with the theme contributions`,
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
