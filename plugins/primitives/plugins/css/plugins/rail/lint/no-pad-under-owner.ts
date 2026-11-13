import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Content inside a region that pays its own inset declares none.
 *
 * A `Column` with `inset`, a `PaneChrome inset="document"` pane and a padded
 * overlay panel are REGION OWNERS: each
 * already moved its content edge, so content dropped in lands on the rail by
 * doing nothing (the rail contract's second rule). A `p-*` / `px-*` on the
 * root of that content pays the inset a second time — the double inset that
 * reads as reasonable at the call site and shows only as content indented
 * twice, the shape `useRailGuard` reports at runtime. This catches it at the
 * source, for the same-file case: the root element of a `Column inset`'s
 * `header` / `body` / `footer`, of a document pane's direct children, and of
 * an overlay panel's `header` / `footer` and direct children.
 *
 * An overlay panel on `padding="none"` is no owner (that is
 * `rail/no-unowned-overlay`'s business), so its children are not checked.
 * Block-only padding (`py-*`, `pt-*`, `pb-*`) is rhythm, not inset, and is
 * left alone.
 *
 *   // eslint-disable-next-line rail/no-pad-under-owner -- <reason>
 */
/** An inline-reaching padding class that ADDS room (`p-0` / `px-none` remove it). */
const INLINE_PAD = /^p[xlrse]?-(?!0$|none$)/;
const OVERLAY_OWNERS = new Set([
  "PopoverContent",
  "InlinePopover",
  "OverlayPanel",
]);
const MENU_CONTENT = /^DropdownMenu\w*Content$/;
const COLUMN_REGIONS = new Set(["header", "body", "footer"]);
const PANEL_STRIPS = new Set(["header", "footer"]);

function elementName(node: TSESTree.JSXOpeningElement): string | undefined {
  return node.name.type === "JSXIdentifier" ? node.name.name : undefined;
}

function attrNamed(
  node: TSESTree.JSXOpeningElement,
  name: string,
): TSESTree.JSXAttribute | undefined {
  for (const a of node.attributes) {
    if (
      a.type === "JSXAttribute" &&
      a.name.type === "JSXIdentifier" &&
      a.name.name === name
    ) {
      return a;
    }
  }
  return undefined;
}

function isLiteral(
  value: TSESTree.JSXAttribute["value"] | undefined,
  literal: string,
): boolean {
  if (value == null) return false;
  if (value.type === "Literal") return value.value === literal;
  return (
    value.type === "JSXExpressionContainer" &&
    value.expression.type === "Literal" &&
    value.expression.value === literal
  );
}

/** The JSX roots a slot value renders: an element, or a fragment's children. */
function rootsOf(
  node: TSESTree.Node | null | undefined,
): TSESTree.JSXElement[] {
  if (node == null) return [];
  if (node.type === "JSXElement") return [node];
  if (node.type === "JSXFragment") return node.children.flatMap(rootsOf);
  if (node.type === "JSXExpressionContainer") {
    return node.expression.type === "JSXEmptyExpression"
      ? []
      : rootsOf(node.expression);
  }
  if (node.type === "ConditionalExpression") {
    return [...rootsOf(node.consequent), ...rootsOf(node.alternate)];
  }
  if (node.type === "LogicalExpression") return rootsOf(node.right);
  return [];
}

export default function buildRule({
  collectTokens,
  ownClass,
  CLASS_ATTRS,
}: LintToolkit) {
  return createRule({
    name: "no-pad-under-owner",
    meta: {
      type: "suggestion",
      docs: {
        description:
          'Disallow an inline padding class on the root of content placed in a region owner (Column inset, PaneChrome inset="document", a padded overlay panel): the host already pays the inset.',
      },
      schema: [],
      messages: {
        padUnderOwner:
          "`{{pad}}` pays an inset `{{owner}}` already paid — the content lands on the rail by doing nothing, so this indents it twice. Delete it: the host owns the inset. (A strip with a rule is the host's `header` / `footer` or a `<Band>`.)",
      },
    },
    defaultOptions: [],
    create(context) {
      function check(roots: TSESTree.JSXElement[], owner: string): void {
        for (const root of roots) {
          for (const a of root.openingElement.attributes) {
            if (
              a.type !== "JSXAttribute" ||
              a.name.type !== "JSXIdentifier" ||
              !CLASS_ATTRS.test(a.name.name) ||
              a.value == null
            ) {
              continue;
            }
            const tokens = new Set<string>();
            collectTokens(context.sourceCode, a.value, tokens);
            for (const token of tokens) {
              const own = ownClass(token);
              if (own !== undefined && INLINE_PAD.test(own)) {
                context.report({
                  node: a,
                  messageId: "padUnderOwner",
                  data: { pad: own, owner },
                });
                break;
              }
            }
          }
        }
      }
      return {
        JSXElement(el: TSESTree.JSXElement) {
          const open = el.openingElement;
          const name = elementName(open);
          if (name === undefined) return;
          if (name === "Column") {
            if (attrNamed(open, "inset") === undefined) return;
            for (const region of COLUMN_REGIONS) {
              check(rootsOf(attrNamed(open, region)?.value), "Column inset");
            }
            return;
          }
          if (name === "PaneChrome") {
            if (!isLiteral(attrNamed(open, "inset")?.value, "document")) return;
            check(el.children.flatMap(rootsOf), 'PaneChrome inset="document"');
            return;
          }
          if (!OVERLAY_OWNERS.has(name) && !MENU_CONTENT.test(name)) return;
          if (isLiteral(attrNamed(open, "padding")?.value, "none")) return;
          for (const strip of PANEL_STRIPS) {
            check(rootsOf(attrNamed(open, strip)?.value), name);
          }
          check(el.children.flatMap(rootsOf), name);
        },
      };
    },
  });
}
