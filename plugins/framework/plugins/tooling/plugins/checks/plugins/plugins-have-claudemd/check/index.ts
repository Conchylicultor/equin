import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/structure-records/core";
import { pluginClaudeMdPath } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";

const check: Check = {
  id: "plugins-have-claudemd",
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
      // Membership of the run's file set — the tree the verdict is about —
      // never a stat per plugin.
      const file = pluginClaudeMdPath(info).replace(`${root}/`, "");
      if (!repo.has(file)) missing.push(file);
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
