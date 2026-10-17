import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type * as ts from "typescript";
import { isGridTrackSize } from "./grid-track";
import type { LintRuleDocs } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator<LintRuleDocs>(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * `ColumnDef.width` is fed verbatim into `grid-template-columns` as a single
 * grid track size by the data-table primitive (see `data-table.tsx`:
 * `columns.map((col) => col.width ?? "auto").join(" ")`). A Tailwind class
 * string (`flex-1 min-w-0`, `w-12 shrink-0`, …) is invalid CSS there: it
 * silently collapses the grid so columns stack vertically.
 *
 * This rule fingerprints the mistake structurally rather than by name: it visits
 * every `width` string-literal property whose enclosing object's CONTEXTUAL type
 * is `ColumnDef` (resolved via the type checker), and reports any value that
 * isn't a valid grid track size per `isGridTrackSize`. Scoping to the contextual
 * `ColumnDef` type means a `width` key on any other object shape is ignored — no
 * false positives — while every column literal is checked regardless of how the
 * array is assembled.
 */
export default createRule({
  name: "no-class-as-grid-width",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Tailwind class strings (or other non-track values) as ColumnDef.width. The data-table primitive feeds width straight into grid-template-columns, so it must be a CSS grid track size (e.g. minmax(0,1fr), 12rem, auto).",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      classAsWidth:
        '`width` is a CSS grid track size fed straight into `grid-template-columns`, not a className. "{{value}}" is not a valid track — use e.g. "minmax(0,1fr)", "12rem", or "auto".',
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      Property(node: TSESTree.Property) {
        // Gate: the property key is `width` (identifier or string-literal key).
        const key = node.key;
        const isWidthKey =
          (key.type === "Identifier" && key.name === "width") ||
          (key.type === "Literal" && key.value === "width");
        if (!isWidthKey) return;

        // Only string-literal values can carry a Tailwind class string.
        if (node.value.type !== "Literal" || typeof node.value.value !== "string") {
          return;
        }

        // The property must live inside an object literal.
        if (node.parent.type !== "ObjectExpression") return;

        // Map the object literal to its TS node and resolve its contextual type.
        const tsObj = services.esTreeNodeToTSNodeMap.get(node.parent) as ts.Expression;
        const t = checker.getContextualType(tsObj);
        if (!t) return;

        // Scope to ColumnDef: match the direct symbol or an alias symbol named
        // `ColumnDef`. Any other shape is ignored (no false positives).
        const name = t.getSymbol()?.getName() ?? t.aliasSymbol?.getName();
        if (name !== "ColumnDef") return;

        if (!isGridTrackSize(node.value.value)) {
          context.report({
            node,
            messageId: "classAsWidth",
            data: { value: node.value.value },
          });
        }
      },
    };
  },
});
