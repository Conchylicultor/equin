import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  findPluginRefs,
  type DotRef,
  type PathRef,
} from "@plugins/plugin-meta/plugins/plugin-refs/core";

const MAX_SHOWN = 50;

function describe(ref: PathRef | DotRef): string {
  if (ref.kind === "dot") return `plugin id "${ref.id}" (${ref.site})`;
  return ref.syntax === "rule-source"
    ? `lint rule import source "@${ref.barrel}" (no ${ref.barrel}/index.ts)`
    : `plugin path "${ref.value}" (${ref.syntax})`;
}

/**
 * Every plugin reference the locator (`plugin-meta/plugin-refs`) finds by path
 * or by dot id must name a real plugin. The locator owns WHERE references live;
 * this check only resolves them — so a new reference site added to the locator
 * is validated here, and rewritten by a mover, with no edit to either.
 */
const check: Check = {
  id: "plugin-refs-resolve",
  description:
    "plugin paths (literals, @plugins specifiers, lint rules' import-source strings — to a real barrel) and dot ids (compositions manifest, reorder overrides, asPluginId, runtimeExceptions) resolve to a real plugin",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const tree = await buildStructureTreeOnce(
      joinAppPath(repo.root, "plugins"),
    );
    const pathSet = new Set([...tree.byPath.keys()].map((p) => `plugins/${p}`));
    const idSet = new Set([...tree.byDir.values()].map((n) => n.id as string));

    const refs = await findPluginRefs(repo, { kinds: ["path", "dot"] });
    const unresolved: Array<PathRef | DotRef> = [];
    for (const ref of refs) {
      if (ref.kind === "path" && !pathSet.has(ref.value)) unresolved.push(ref);
      // A rule's import source must name a barrel, not just a plugin: a tsc
      // import would refuse a missing one, a string the rule compares never does.
      else if (
        ref.kind === "path" &&
        ref.syntax === "rule-source" &&
        !repo.has(`${ref.barrel}/index.ts`)
      ) {
        unresolved.push(ref);
      }
      if (ref.kind === "dot" && !idSet.has(ref.id)) unresolved.push(ref);
    }

    if (unresolved.length === 0) return { ok: true };
    const shown = unresolved
      .slice(0, MAX_SHOWN)
      .map((r) => `  ${r.file}:${r.line} — ${describe(r)} does not resolve`);
    const more =
      unresolved.length > MAX_SHOWN
        ? `\n  … +${unresolved.length - MAX_SHOWN} more`
        : "";
    return {
      ok: false,
      message: `${unresolved.length} unresolved plugin reference(s):\n${shown.join("\n")}${more}`,
      hint:
        "A plugin was likely moved or renamed. Update each reference to the plugin's new path/id. " +
        "The sites are listed by plugin-meta/plugin-refs (findPluginRefs).",
    };
  },
};

export default check;
