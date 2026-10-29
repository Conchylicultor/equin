import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Steer a standalone icon action toward the curated `IconButton` primitive.
 *
 * `IconButton` (`@plugins/primitives/plugins/icon-button/web`) is the sanctioned
 * way to render a single icon action: it injects the mandatory `aria-label` +
 * tooltip and renders a bare `<Icon/>`, so the control is always accessible. A
 * hand-rolled `<Button><Icon icon={…}/></Button>` slips past that — the audit found exactly
 * this (an icon action with no `aria-label`).
 *
 * The `aspect` axis is NOT part of the test, because the wrong half of it is the
 * more common mistake: a `<Button>` with no `aspect` defaults to `aspect="text"`,
 * so an icon dropped into it gets a TEXT box — `control-*` height with `px-2.5`
 * on both sides — and sits ~8px wider than the square `IconButton` beside it in
 * the same toolbar. That is what the conversation action bar looked like: half
 * its icon actions square, half of them padded. Gating the rule on
 * `aspect="icon"` caught only the half that already had the geometry right.
 *
 * So the rule fires on the unmistakable "single icon glyph as a direct,
 * standalone child" shape, at any aspect:
 *
 *   1. the element's `aspect` is absent (→ the `"text"` default) or the string
 *      literal `"icon"` — `"inline"` and any computed value are left alone, AND
 *   2. its children — ignoring whitespace `JSXText` — are EXACTLY ONE
 *      `JSXElement`, AND
 *   3. that child's tag identifier resolves (via scope → import binding) to
 *      the icons primitive's `<Icon>` (`@plugins/ui/plugins/icons/web`) — the
 *      `IconButton.icon` contract, AND
 *   4. the `<Button>` is NOT a render-target prop value (`trigger={<Button…/>}`
 *      / `render={<Button…/>}`), which legitimately keeps a bare Button.
 *
 * A justified one-off — a placeholder that must keep a text box's width, a
 * text-glyph button, a stateful-indicator child — escapes per-site via
 * `// eslint-disable-next-line icon-button/prefer-icon-button -- <reason>`.
 *
 * This is pure JSX-structure inspection (scope walk for the import binding) — no
 * `@plugins`/shared imports — so it loads cleanly under jiti, which cannot
 * resolve the `@plugins/*` alias. No auto-fix (the label text can't be inferred).
 */

const ICON_MODULES = /^@plugins\/ui\/plugins\/icons\/web$/;

/**
 * Resolve a JSX child-element's tag identifier to the module it was imported
 * from, returning that module specifier (or null if it isn't an import binding).
 * Same-file scope walk only — a local component or a member-expression tag
 * (`<foo.Bar/>`) is not an icon import and yields null.
 */
function importSourceOfTag(
  sourceCode: TSESLint.SourceCode,
  name: TSESTree.JSXTagNameExpression,
): string | null {
  if (name.type !== "JSXIdentifier") return null;
  let scope: TSESLint.Scope.Scope | null = sourceCode.getScope(
    name as unknown as TSESTree.Node,
  );
  let variable: TSESLint.Scope.Variable | undefined;
  while (scope && !variable) {
    variable = scope.variables.find((v) => v.name === name.name);
    scope = scope.upper;
  }
  if (!variable) return null;
  for (const def of variable.defs) {
    if (
      def.type === "ImportBinding" &&
      def.parent.type === "ImportDeclaration" &&
      typeof def.parent.source.value === "string"
    ) {
      return def.parent.source.value;
    }
  }
  return null;
}

export default createRule({
  name: "prefer-icon-button",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Steer a standalone `<Button>` whose only child is an icon glyph toward `<IconButton icon={…} label=… />`, which adds the mandatory aria-label + tooltip and the square icon box.",
    },
    schema: [],
    messages: {
      preferIconButton:
        'A standalone icon action should use `<IconButton icon={…} label=… />` — it adds the mandatory aria-label + tooltip, and the square `aspect="icon"` box so it matches the other icon actions in its row (a default `<Button>` is text-shaped and renders ~8px wider). Keep a bare `<Button>` only for triggers / text-glyph / stateful children, with a per-site disable naming the reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXElement(node) {
        const opening = node.openingElement;
        const tag = opening.name;
        if (tag.type !== "JSXIdentifier" || tag.name !== "Button") return;

        // (1) the box is icon-shaped or text-shaped — i.e. `aspect` is absent
        // (the `"text"` default) or the literal `"icon"`. A spread
        // (`{...props}`) can carry an `aspect` this walk cannot see, so a
        // `<Button>` with no explicit `aspect` is only judged when it also has
        // no spread; `"inline"` and any computed value are left alone.
        const aspectAttr = opening.attributes.find(
          (attr): attr is TSESTree.JSXAttribute =>
            attr.type === "JSXAttribute" &&
            attr.name.type === "JSXIdentifier" &&
            attr.name.name === "aspect",
        );
        if (aspectAttr) {
          const value = aspectAttr.value;
          if (
            value?.type !== "Literal" ||
            (value.value !== "icon" && value.value !== "text")
          ) {
            return;
          }
        } else if (
          opening.attributes.some((attr) => attr.type === "JSXSpreadAttribute")
        ) {
          return;
        }

        // (4) skip render-target prop values: `trigger={<Button…/>}` etc.
        if (
          node.parent.type === "JSXExpressionContainer" &&
          node.parent.parent.type === "JSXAttribute"
        ) {
          return;
        }

        // (2) children, ignoring whitespace JSXText, are exactly one JSXElement.
        const meaningful = node.children.filter(
          (c) => !(c.type === "JSXText" && c.value.trim() === ""),
        );
        if (meaningful.length !== 1) return;
        const only = meaningful[0]!;
        if (only.type !== "JSXElement") return;

        // (3) that child's tag resolves to an icon import.
        const source = importSourceOfTag(
          context.sourceCode,
          only.openingElement.name,
        );
        if (!source || !ICON_MODULES.test(source)) return;

        context.report({ node, messageId: "preferIconButton" });
      },
    };
  },
});
