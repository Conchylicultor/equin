import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A panel is never bled.
 *
 * A floating panel surface IS the region — its `padding` role is literally a
 * `rail-<step>` — so cancelling its own rail is always a mistake, whoever writes
 * it. That total-ness is what makes this a rule rather than a heuristic: there
 * is no context in which `<DialogContent className="rail-bleed">` is correct.
 *
 * **Why anyone reaches for it.** `DialogContent.padded` was deleted, correctly —
 * an escape absent from the type cannot be reached for. The muscle-memory
 * replacement is `className="rail-bleed"`, and it half-works, which is worse
 * than failing: `className` lands last, `rail-bleed` is in the `px` twmerge
 * group, so it STRIPS the panel's `rail-lg`. The panel loses its inset (visibly
 * what the author wanted) while simultaneously acquiring negative inline margins
 * and `width: calc(100% + 0px)` against a rail that is now zero. It looks
 * approximately right in a screenshot and is wrong in the DOM — and every
 * descendant that follows or bleeds the rail now reads `0px`.
 *
 * The fix is always one level in: a BAND inside the panel bleeds — a header
 * strip, a hairline, a row whose fill must reach the panel edge — and the panel
 * keeps its region. That is the shape `quick-find`, `command-palette` and
 * `version-history` were all migrated to.
 *
 * **Conservative by construction**, because it runs repo-wide as `error`:
 *
 *   - it matches only the panel-surface element NAMES below — the closed set of
 *     boxes that own a padding role — never an arbitrary component that happens
 *     to take a `className`;
 *   - it matches only a literal `rail-bleed` TOKEN in a class expression. A
 *     class routed through a `const` or a lookup map is out of scope, the same
 *     trade `no-adhoc-panel-body` makes and for the same reason: this closes the
 *     shape people actually write.
 *
 * Name-based matching with no cross-file type resolution is the house
 * convention (`no-adhoc-row-list` documents the trade): an aliased import
 * evading it is accepted, not a gap.
 *
 * Escape hatch per-site, travelling with the code:
 *
 *   // eslint-disable-next-line rail/no-panel-bleed -- <reason>
 */

/**
 * The closed set of panel surfaces — every box that opens the region by owning a
 * `padding` role (`POPOVER_PADDING` maps each role to one `rail-<step>`).
 *
 * `DropdownMenu*Content` is matched by pattern so `DropdownMenuSubContent` and
 * any future sibling are covered without an edit; the rest are named.
 */
const PANEL_CONTENT = /^DropdownMenu\w*Content$/;

const PANEL_SURFACES = new Set([
  "OverlayPanel",
  "DialogContent",
  "PopoverContent",
  "SelectContent",
  "InlinePopover",
  "FloatingSurface",
  "ControlPanelPopover",
]);

function isPanelSurface(name: string): boolean {
  return PANEL_SURFACES.has(name) || PANEL_CONTENT.test(name);
}

/** The one token that cancels a rail. */
const BLEED_TOKEN = "rail-bleed";

/**
 * Every whitespace-separated chunk of every string literal and template chunk
 * under one class-name expression.
 *
 * The same deliberately-simple reader `no-adhoc-panel-body` uses, and NOT the
 * shared `class-token-walk` block: the question here is one element's own
 * `className`, not a whole-file alias resolution.
 */
function classTokens(node: TSESTree.Node, out: string[]): void {
  // An if-chain rather than a `switch`: the switched value would be the full AST
  // node-kind union, which `switch-exhaustiveness-check` asks every branch of.
  // This walk cares about eight shapes and ignores the rest by design.
  if (node.type === "Literal") {
    if (typeof node.value === "string") out.push(...node.value.split(/\s+/));
    return;
  }
  if (node.type === "TemplateLiteral") {
    for (const quasi of node.quasis) out.push(...quasi.value.raw.split(/\s+/));
    for (const expr of node.expressions) classTokens(expr, out);
    return;
  }
  if (node.type === "JSXExpressionContainer") {
    classTokens(node.expression, out);
    return;
  }
  if (node.type === "CallExpression") {
    for (const arg of node.arguments) classTokens(arg, out);
    return;
  }
  if (node.type === "ConditionalExpression") {
    classTokens(node.consequent, out);
    classTokens(node.alternate, out);
    return;
  }
  if (node.type === "LogicalExpression") {
    classTokens(node.left, out);
    classTokens(node.right, out);
    return;
  }
  if (node.type === "ArrayExpression") {
    for (const el of node.elements) if (el) classTokens(el, out);
    return;
  }
  if (node.type === "ObjectExpression") {
    // `cn({ "rail-bleed": flush })` — the KEY is the class string.
    for (const prop of node.properties) {
      if (prop.type === "Property") classTokens(prop.key, out);
    }
  }
}

export default function buildRule({ CLASS_ATTRS }: LintToolkit) {
  return createRule({
    name: "no-panel-bleed",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow `rail-bleed` on a floating panel surface. A panel IS the rail region, so bleeding it strips its own padding role and leaves every descendant reading a zero rail.",
      },
      schema: [],
      messages: {
        panelBleed:
          "`rail-bleed` on `{{surface}}` cancels the panel's OWN rail. A panel is the region: its `padding` role is a `rail-<step>`, and `rail-bleed` shares that tailwind-merge group — so this strips the panel's inset AND leaves it with negative margins and `width: calc(100% + 0px)` against a rail that is now zero. Every descendant that follows or bleeds the rail then reads `0px` too. Bleed a BAND inside the panel instead — the header strip, the hairline, the row whose fill must reach the panel edge — and leave the panel its region.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
          if (node.name.type !== "JSXIdentifier") return;
          const surface = node.name.name;
          if (!isPanelSurface(surface)) return;
          for (const attr of node.attributes) {
            if (attr.type !== "JSXAttribute") continue;
            if (
              attr.name.type !== "JSXIdentifier" ||
              !CLASS_ATTRS.test(attr.name.name) ||
              attr.value == null
            ) {
              continue;
            }
            const tokens: string[] = [];
            classTokens(attr.value, tokens);
            if (tokens.includes(BLEED_TOKEN)) {
              context.report({
                node: attr,
                messageId: "panelBleed",
                data: { surface },
              });
            }
          }
        },
      };
    },
  });
}
