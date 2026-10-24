import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import {
  renderSpaceRamp,
  spaceRampManifestPath,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const check: Check = {
  id: "space-ramp-in-sync",
  description:
    "space-ramp/core/ramp.generated.ts matches the `/* @ramp … */` declarations in app.css (the spacing ramp's source of truth)",
  async run() {
    const root = await getWorktreeRoot();
    const file = spaceRampManifestPath(root);
    const rel = relative(root, file);

    // A thrown declaration-validation error (a missing/duplicated `@ramp` decl, or
    // a declared family missing a declared step) is a legitimate check failure,
    // not a crash — report it as the failure message.
    let expected: string;
    try {
      expected = renderSpaceRamp(root);
    } catch (err) {
      return {
        ok: false,
        message: `app.css @ramp declarations are invalid: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Fix the `/* @ramp … */` declaration (or add the missing `@utility`) in app.css, then run `./equin build`.",
      };
    }

    if (!existsSync(file)) {
      return {
        ok: false,
        message: `${rel} is missing`,
        hint: "Run `./equin build` to generate it.",
      };
    }
    if (
      readFileSync(file, "utf8") !==
      (await formatGenerated({ file, content: expected }))
    ) {
      return {
        ok: false,
        message: `${rel} is out of sync with the app.css @ramp declarations`,
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
