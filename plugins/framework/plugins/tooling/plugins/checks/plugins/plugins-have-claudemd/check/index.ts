import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { pluginClaudeMdPath } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";

const check: Check = {
  id: "plugins-have-claudemd",
  wholeTreeRead: {
    kind: "debt",
    task: "task-1794579727-rjy6wx",
    reason: "stats every plugin's CLAUDE.md (1.8k)",
  },
  description:
    "every plugin has a CLAUDE.md (auto-generated, optionally with hand-written prose above the AUTOGEN fence)",
  async run(ctx: CheckContext) {
    const repo = await ctx.repo();
    const { root } = repo;
    const tree = await buildStructureTreeOnce(
      joinAppPath(root, "plugins"),
      repo,
    );
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
