import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import {
  barrelStubsPath,
  renderBarrelStubs,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const check: Check = {
  id: "barrel-stubs-in-sync",
  description:
    "auto-stubs.generated.ts matches auto-stub-packages.ts and current .d.ts files",
  async run() {
    const root = await getWorktreeRoot();
    const file = barrelStubsPath(root);
    const rel = relative(root, file);
    if (!existsSync(file)) {
      return {
        ok: false,
        message: `${rel} is missing`,
        hint: "Run `./equin build` to generate it.",
      };
    }
    let expected: string;
    try {
      expected = renderBarrelStubs({ root });
    } catch (e) {
      return {
        ok: false,
        message: `barrel-stubs-gen failed: ${e instanceof Error ? e.message : String(e)}`,
        hint: "Fix the error in auto-stub-packages.ts or stubs.ts.",
      };
    }
    if (
      readFileSync(file, "utf8") !==
      (await formatGenerated({ file, content: expected }))
    ) {
      return {
        ok: false,
        message: `${rel} is out of sync with auto-stub-packages.ts or node_modules .d.ts files`,
        hint: "Run `./equin build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
