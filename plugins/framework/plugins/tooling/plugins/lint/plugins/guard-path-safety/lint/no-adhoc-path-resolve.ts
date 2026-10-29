import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The directory this rule fences — the PreToolUse guards themselves.
 *
 * Repo lint rules are enabled repo-wide over `**\/*.{ts,tsx}`, so the rule
 * short-circuits on every other file (the `no-adhoc-check-runner` precedent).
 * The fence is `core/guards/`, not the whole guards plugin: `core/argv.ts` is
 * the one file that MAY build a path, and it sits one level up.
 */
const GUARDS_DIR =
  "plugins/framework/plugins/tooling/plugins/guards/core/guards/";

/**
 * The path constructor, in both spellings a guard could reach for. `node:path`
 * is the repo idiom; bare `path` resolves to the same builtin and would slip a
 * rule that only knew the prefixed form.
 */
const PATH_MODULES = new Set(["node:path", "path"]);

export default createRule({
  name: "no-adhoc-path-resolve",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow value imports from node:path inside the PreToolUse guards — " +
        "every filesystem path a guard compares must come from core/argv.ts, " +
        "which owns the per-command operand grammar and the cwd fold.",
    },
    schema: [],
    messages: {
      adhocPath:
        "A guard must not construct a filesystem path itself. Building one here " +
        "means the operand it starts from was guessed out of `call.args`, and a " +
        "guessed operand is how `sed -i '' 's|a|b|' <worktree-file>` got blocked: " +
        "path.resolve() normalised the `..` inside the SUBSTITUTION SCRIPT and " +
        "landed it under the main repo root, so the guard named a fragment of the " +
        "script as the file being written. Take the paths from " +
        "plugins/framework/plugins/tooling/plugins/guards/core/argv.ts instead — " +
        "`parseArgv(call).files[].path` and `.targetDir` for operands, " +
        "`redirectionTargets(call)` for `>` / `>>` — which apply the per-command " +
        "operand grammar and fold in `call.cwd`, and hand back absolute paths " +
        "already resolved. Type-only imports are fine; only building a path is " +
        "banned. `call.args` itself stays readable — several guards legitimately " +
        "scan it for flag clusters, `-prune`, or a git subcommand.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? "")
      .split("\\")
      .join("/");
    if (!filename.includes(GUARDS_DIR)) return {};

    return {
      ImportDeclaration(node) {
        // `import type { … } from "node:path"` — naming a path type costs
        // nothing; only holding the constructor does.
        if (node.importKind === "type") return;
        if (typeof node.source.value !== "string") return;
        if (!PATH_MODULES.has(node.source.value)) return;

        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            // A per-specifier `import { type ParsedPath, join }` still reaches
            // here for the value half; the type half carries its own kind.
            if (spec.importKind === "type") continue;
            context.report({ node: spec, messageId: "adhocPath" });
          } else {
            // Default and namespace imports (`import path from "node:path"`,
            // `import * as path from "node:path"`) reach every constructor at
            // once, so they are the same violation.
            context.report({ node: spec, messageId: "adhocPath" });
          }
        }
      },
    };
  },
});
