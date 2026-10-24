import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import {
  renderCustomUtilities,
  customUtilitiesManifestPath,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const check: Check = {
  id: "app-css-utilities-in-sync",
  description:
    "custom-utilities.generated.ts matches the `/* twmerge: … */` markers in app.css (the twMerge registry source of truth)",
  async run() {
    const root = await getWorktreeRoot();
    const file = customUtilitiesManifestPath(root);
    const rel = relative(root, file);

    // A thrown marker-validation error (missing/invalid `/* twmerge: … */`) is a
    // legitimate check failure, not a crash — report it as the failure message.
    let expected: string;
    try {
      expected = renderCustomUtilities(root);
    } catch (err) {
      return {
        ok: false,
        message: `app.css custom-@utility markers are invalid: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Fix the `/* twmerge: … */` marker in app.css, then run `./equin build`.",
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
        message: `${rel} is out of sync with the app.css @utility markers`,
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
