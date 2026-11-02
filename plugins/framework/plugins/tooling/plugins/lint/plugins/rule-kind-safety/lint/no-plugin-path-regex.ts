import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A pattern that names ONE plugin by its path: an `@plugins/<name>` specifier,
 * or a `<dir>/plugins/<child>` step. A bare `@plugins/` prefix and generic
 * folder grammar (`plugins/(?:[^/]+/plugins/)*`, `/plugins/check/`) name no
 * plugin and are fine.
 */
const NAMES_A_PLUGIN =
  /@plugins\/[A-Za-z0-9_-]|[A-Za-z0-9_-]\/plugins\/[A-Za-z0-9_-]/;

/** Read a regex source the way it matches: `\/` is `/`. */
const unescapeSlashes = (pattern: string) => pattern.replaceAll("\\/", "/");

/** Non-test code under a plugin's `lint/` folder — a rule's own source. */
function isLintRuleSource(filename: string): boolean {
  const segs = filename.split("\\").join("/").split("/");
  return segs.some((s, i) => s === "lint" && segs[i - 2] === "plugins");
}

/**
 * A lint rule names the plugins it matches as STRINGS, never as patterns.
 * plugin-meta/plugin-refs locates a rule's `@plugins/…` string (and any
 * `plugins/…` path literal), so `plugin-refs-resolve` fails when the barrel or
 * path is gone and `./equin plugin move` rewrites it. A regex is located by
 * nothing: after a move it keeps matching the old path, and the rule silently
 * catches nothing — `no-adhoc-caret-trigger` matched `floating-surface`'s
 * pre-move specifier for two months.
 */
export default createRule({
  name: "no-plugin-path-regex",
  meta: {
    type: "problem",
    docs: {
      description:
        "A lint rule names a plugin it matches as a string (located and checked by plugin-refs), never inside a regex.",
    },
    schema: [],
    messages: {
      regex:
        "This regex names a plugin by its path, which nothing locates: once the plugin moves it matches the old path and the rule silently catches nothing. " +
        'Spell it as a string — an import source as the exact `"@plugins/…/<runtime>"` compared with `===`, a file path as a `"plugins/…"` literal tested with `startsWith` / `includes` — ' +
        "so plugin-meta/plugin-refs locates it: `plugin-refs-resolve` fails when it goes stale, `./equin plugin move` rewrites it.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isLintRuleSource(context.filename)) return {};
    const check = (node: TSESTree.Node, pattern: string) => {
      if (NAMES_A_PLUGIN.test(unescapeSlashes(pattern))) {
        context.report({ node, messageId: "regex" });
      }
    };
    return {
      Literal(node) {
        if ("regex" in node && node.regex) check(node, node.regex.pattern);
      },
      NewExpression(node) {
        const [arg] = node.arguments;
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "RegExp" &&
          arg?.type === "Literal" &&
          typeof arg.value === "string"
        ) {
          check(node, arg.value);
        }
      },
    };
  },
});
