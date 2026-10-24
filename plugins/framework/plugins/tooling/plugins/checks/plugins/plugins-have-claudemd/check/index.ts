import { existsSync } from "fs";
import { join } from "path";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { pluginClaudeMdPath } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const check: Check = {
  id: "plugins-have-claudemd",
  description:
    "every plugin has a CLAUDE.md (auto-generated, optionally with hand-written prose above the AUTOGEN fence)",
  async run() {
    const root = await getWorktreeRoot();
    const tree = await buildStructureTreeOnce(join(root, "plugins"));
    const missing: string[] = [];
    for (const info of tree.byDir.values()) {
      const file = pluginClaudeMdPath(info);
      if (!existsSync(file)) missing.push(file.replace(`${root}/`, ""));
    }
    if (missing.length > 0) {
      return {
        ok: false,
        message: `${missing.length} plugin(s) missing CLAUDE.md: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`,
        hint: "Run `./equin build` to generate them.",
      };
    }
    return { ok: true };
  },
};

export default check;
