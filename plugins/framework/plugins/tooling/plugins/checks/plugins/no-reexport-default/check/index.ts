import { join, relative, sep } from "path";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { maskSource } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";

const RUNTIMES = ["web", "server", "machine", "central"] as const;

const INLINE_DEFAULT_RE = /(^|\n)\s*export\s+default\s+\{/;
const REEXPORT_DEFAULT_RE =
  /(^|\n)\s*export\s*\{[^}]*\bdefault\b[^}]*\}\s*from\b/;
const ANY_DEFAULT_RE =
  /(^|\n)\s*export\s+default\b|export\s*\{[^}]*\bdefault\b[^}]*\}/;

const check: Check = {
  id: "no-reexport-default",
  description:
    "Every plugin barrel (web|server|machine|central)/index.ts must use inline `export default { ... } satisfies *PluginDefinition` — no re-exports, no missing defaults",
  async run(ctx: CheckContext) {
    const root = await getWorktreeRoot();
    const pluginsRoot = join(root, "plugins");

    const repo = await ctx.repo();
    if (repo.under("plugins").length === 0) return { ok: true };

    const tree = await buildStructureTreeOnce(pluginsRoot);
    const missing: string[] = [];
    const reexported: string[] = [];

    for (const node of tree.byDir.values()) {
      for (const runtime of RUNTIMES) {
        const barrelRel = relative(root, join(node.dir, runtime, "index.ts"))
          .split(sep)
          .join("/");
        if (!repo.has(barrelRel)) continue;

        const rawSrc = await repo.read(barrelRel);
        if (rawSrc === null) continue;

        // Fully mask comments, regex literals, AND string interiors: the three
        // regexes only detect code constructs (`export default`, `export { …
        // default … } from`), never read a string value — so masking strings
        // closes the string-embedded false-positive (a default-export shape
        // mentioned in a comment or string can't be mistaken for a real one).
        const src = maskSource(rawSrc);

        if (!ANY_DEFAULT_RE.test(src)) {
          missing.push(barrelRel);
        } else if (
          REEXPORT_DEFAULT_RE.test(src) &&
          !INLINE_DEFAULT_RE.test(src)
        ) {
          reexported.push(barrelRel);
        }
      }
    }

    const problems = [
      ...missing.map((f) => `  missing default export: ${f}`),
      ...reexported.map((f) => `  re-exported default: ${f}`),
    ];

    if (problems.length === 0) return { ok: true };

    return {
      ok: false,
      message: `${problems.length} barrel(s) violate inline default export rule:\n${problems.join("\n")}`,
      hint: "Add `export default { description } satisfies ServerPluginDefinition` (or PluginDefinition / CentralPluginDefinition) inline in the barrel. (`id` is derived from the plugin path — never authored; there is no `name` field.)",
    };
  },
};

export default check;
