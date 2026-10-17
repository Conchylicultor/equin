import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * Control-panel body guardrail.
 *
 * A data-control panel — the body of a Filter, Sort or view-settings popover —
 * is drawn with the `control-panel` vocabulary, where the CONTAINER separates
 * its children. An author never places a divider, so the rhythm cannot go ragged
 * one panel at a time and a conditionally-null section leaves no orphan rule.
 *
 * The rule watches four ways a hand-rolled panel body announces itself. The
 * first three are about SECTIONING, because sectioning is empirically how every
 * one of these panels drifted:
 *
 *   A. a `DropdownMenuSeparator` borrowed outside a dropdown menu. It is a menu
 *      part; a panel that reaches for it is sectioning by hand with the nearest
 *      divider it could find.
 *   B. a `<Separator>` inside a floating panel surface — the "switch to the
 *      generic divider to dodge signal A" move, which is the same decision.
 *   C. a hairline built out of raw utilities (`h-px` + a `bg-border` token) —
 *      the same divider, hand-drawn.
 *
 * The fourth closes a different fork — TWO HOSTS for one body:
 *
 *   D. a `<ControlPanel>` whose nearest hosting surface is a generic floating
 *      one (`InlinePopover`, `PopoverContent`, `DropdownMenu*Content`, …) rather
 *      than `ControlPanelPopover`. This is not a style preference: the panel body
 *      owns the content inset and the full-bleed hairlines, and it can only do
 *      that when the surface contributes NO padding of its own. A generic host
 *      brings its own padding role, so the same body draws at two different
 *      insets depending on who opened it — which is exactly how the migrated
 *      panels silently lost their edge inset (`InlinePopover` defaults to
 *      `padding="md"`, `ControlPanelPopover` sets `padding="none"`). A
 *      `DialogContent` host stays legal: a dialog is the documented second home
 *      for a bare `<ControlPanel>`, inheriting the dialog's own width.
 *
 * **Honest about coverage.** A body assembled from `Stack` + `SectionLabel` +
 * `Button` with no divider at all is invisible here. This closes the DRIFT
 * signals — borrowed dividers and hand-rolled hairlines — not the whole class.
 * The allowlist in `lint/index.ts` is the rest of the forcing function, and it
 * only shrinks.
 *
 * This is a JSX-STRUCTURE rule, modelled on ui-kit's
 * `no-groupless-dropdown-menu-label`: a `JSXOpeningElement` visitor that walks
 * the parent chain up to the enclosing COMPONENT. A separator rendered in a
 * different component from any menu is the ambiguous case worth a look.
 *
 * "Component" is the load-bearing word, and it is narrower than "function". The
 * walk stops at a function DECLARATION or an arrow/function expression bound to
 * a capitalized name — the shapes that define a component — and walks straight
 * through an inline callback. A separator inside `groups.map((g) => …)` is in
 * the same JSX tree as the `DropdownMenuContent` around the map, not in a
 * different component, and stopping there would report every grouped menu in
 * the repo.
 *
 * It takes the shared class-token walk from the injected toolkit like every
 * other class rule, but uses only its `CLASS_ATTRS`: signal C needs one
 * element's own class expression, not a
 * whole-file alias resolution, so it reads a deliberately simpler set of tokens:
 * string literals and template chunks inside the element's `className`. A class
 * string routed through a `const` or a lookup map is out of scope here on
 * purpose — the burndown list is what catches those.
 *
 * Escape hatch per-site, travelling with the code:
 *
 *   // eslint-disable-next-line control-panel/no-adhoc-panel-body -- <reason>
 */

/** `DropdownMenuContent`, `DropdownMenuSubContent`, … — a real menu surface. */
const MENU_CONTENT = /^DropdownMenu\w*Content$/;

/**
 * Menu surfaces that do not carry the `DropdownMenu…Content` name but ARE one.
 * `CursorAnchoredMenu` (primitives/overlay/cursor-menu) renders its children directly
 * into a `DropdownMenuContent`; a separator inside it is a menu separator doing
 * its job.
 */
const MENU_SURFACE_ALIASES = new Set(["CursorAnchoredMenu"]);

function isMenuSurface(name: string): boolean {
  return MENU_CONTENT.test(name) || MENU_SURFACE_ALIASES.has(name);
}

/** The floating surfaces a control panel's body is hosted in. */
const PANEL_SURFACES = new Set([
  "PopoverContent",
  "InlinePopover",
  "OverlayPanel",
  "FloatingSurface",
]);

/**
 * The hosts that may legally contain a `<ControlPanel>` body (signal D).
 *
 * `ControlPanelPopover` is the sanctioned one — it is the surface built to
 * contribute no padding, so the body's own inset is the only one. `DialogContent`
 * is the documented second home: a bare panel inside a dialog inherits the
 * dialog's width and padding role deliberately, and there is no popover-width
 * role to bypass.
 */
const LEGAL_PANEL_HOSTS = new Set(["ControlPanelPopover", "DialogContent"]);

/**
 * Is this JSX element a surface that HOSTS content — legal or not? The walk for
 * signal D stops at the first one of these, so the question asked is "what is
 * the NEAREST host", not "is a legal host reachable anywhere above me". A
 * `ControlPanelPopover` several levels up does not excuse an `InlinePopover`
 * opened inside it.
 */
function isPanelHost(name: string): boolean {
  return (
    LEGAL_PANEL_HOSTS.has(name) ||
    PANEL_SURFACES.has(name) ||
    isMenuSurface(name)
  );
}

/**
 * Is this function the definition of a COMPONENT — the boundary the walk stops
 * at — or an inline callback, which is part of the same JSX tree?
 *
 * A `function Foo()` declaration always counts. An arrow or function expression
 * counts only when it is bound to a capitalized name (`const Panel = () => …`),
 * which is what a component looks like. Everything else — a `.map()` argument, a
 * render prop, a JSX expression child — is the same tree as the JSX around it,
 * so the walk passes through.
 */
function isComponentBoundary(node: TSESTree.Node): boolean {
  if (node.type === "FunctionDeclaration") return true;
  if (
    node.type !== "FunctionExpression" &&
    node.type !== "ArrowFunctionExpression"
  ) {
    return false;
  }
  const parent = node.parent;
  return (
    parent?.type === "VariableDeclarator" &&
    parent.id.type === "Identifier" &&
    /^[A-Z]/.test(parent.id.name)
  );
}

/** A 1px rule drawn by hand. */
const HAIRLINE_HEIGHT = /^h-px$/;
const BORDER_FILL = /^bg-border/;

/**
 * Walk up from a JSX element, returning the name of the first ancestor JSX
 * element that `matches`, or null once the enclosing component (or the top) is
 * reached first.
 */
function ancestorMatching(
  node: TSESTree.JSXOpeningElement,
  matches: (name: string) => boolean,
): string | null {
  let current: TSESTree.Node | undefined = node.parent;
  while (current) {
    if (current.type === "JSXElement") {
      const opening = current.openingElement.name;
      if (opening.type === "JSXIdentifier" && matches(opening.name)) {
        return opening.name;
      }
    }
    if (isComponentBoundary(current)) break;
    current = current.parent;
  }
  return null;
}

/**
 * The simple token reader for signal C: every whitespace-separated chunk of
 * every string literal and template chunk under one class-name expression.
 * No `const`/map alias resolution — see the note above; this is not the shared
 * `class-token-walk`.
 */
function classTokens(node: TSESTree.Node, out: string[]): void {
  // An if-chain rather than a `switch`: the switched value would be the full
  // AST node-kind union, which `switch-exhaustiveness-check` asks every branch
  // of. This walk cares about eight shapes and ignores the rest by design, and
  // enumerating ~200 node kinds to say so would bury that.
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
    // `clsx({ "h-px bg-border": cond })` — the KEY is the class string.
    for (const prop of node.properties) {
      if (prop.type === "Property") classTokens(prop.key, out);
    }
  }
}

export default function buildRule({ CLASS_ATTRS }: LintToolkit) {
  return createRule({
    name: "no-adhoc-panel-body",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow hand-rolled control-panel sectioning — a borrowed DropdownMenuSeparator, a Separator inside a floating panel surface, or a hand-drawn h-px hairline. The ControlPanel container draws the rules between its own children.",
      },
      schema: [],
      messages: {
        separatorOutsideMenu:
          "`DropdownMenuSeparator` is a dropdown-menu part, but this one has no `DropdownMenu*Content` ancestor in the same component — so it is sectioning something by hand. If this is a data-control panel body, build it from `ControlPanel` / `ControlPanel.Section` (@plugins/primitives/plugins/css/plugins/control-panel/web): the container draws the hairline BETWEEN its direct children, so a conditionally-empty section leaves no orphan rule and every panel keeps the same rhythm.",
        separatorInPanel:
          "A `<Separator>` inside a floating panel surface is a divider placed by hand. Build the panel body from `ControlPanel` / `ControlPanel.Section` (@plugins/primitives/plugins/css/plugins/control-panel/web) and drop the separator — the container separates its own direct children, so sections cannot go out of rhythm with each other.",
        handRolledHairline:
          "This is a hairline drawn out of raw utilities (`h-px` + a `bg-border` fill). Inside a control panel, delete it and let `ControlPanel` separate its children; elsewhere, use the `<Separator>` primitive from @plugins/primitives/plugins/css/plugins/ui-kit/web so one divider recipe answers for the whole app.",
        panelInGenericSurface:
          "A `<ControlPanel>` body must be hosted by `ControlPanelPopover`, but the nearest surface around this one is `{{host}}` — a generic floating surface that contributes its own padding role. The panel body owns the content inset and draws its hairlines full-bleed through it, so a host that also pads draws the same panel at a different inset than every other panel in the app. Open it with `ControlPanelPopover` (@plugins/primitives/plugins/css/plugins/control-panel/web), which sets `padding=\"none\"` and sizes the panel by its content's declared width need. A `DialogContent` host is legal — a bare panel inside a dialog inherits the dialog's width on purpose.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
          if (node.name.type === "JSXIdentifier") {
            const name = node.name.name;

            // (A) A menu's own divider, used where there is no menu. The
            // "file contains no `DropdownMenu*Content` at all" case is the
            // strictly weaker half of this same question, so the ancestor walk
            // answers both: no reachable menu surface ⇒ report.
            if (name === "DropdownMenuSeparator") {
              if (ancestorMatching(node, isMenuSurface) === null) {
                context.report({ node, messageId: "separatorOutsideMenu" });
              }
            }

            // (B) The generic divider, inside a floating panel. Catches the
            // "switch to `<Separator/>` to dodge signal A" move — the panel is
            // still sectioning itself by hand.
            if (name === "Separator") {
              if (
                ancestorMatching(node, (n) => PANEL_SURFACES.has(n)) !== null
              ) {
                context.report({ node, messageId: "separatorInPanel" });
              }
            }

            // (D) The panel body, hosted by the wrong surface. Same ancestor walk,
            // but stopping at the NEAREST host of any kind and then classifying
            // it — so a `ControlPanelPopover` further up cannot vouch for an
            // `InlinePopover` opened inside it. No host at all in this component
            // is not reported: a body factored into its own component is the
            // normal shape, and the host is then someone else's line.
            if (name === "ControlPanel") {
              const host = ancestorMatching(node, isPanelHost);
              if (host !== null && !LEGAL_PANEL_HOSTS.has(host)) {
                context.report({
                  node,
                  messageId: "panelInGenericSurface",
                  data: { host },
                });
              }
            }
          }

          // (C) The divider, hand-drawn. One element's own class expression must
          // carry BOTH halves of the recipe — a bare `h-px` (a spacer) or a bare
          // `bg-border` (a border colour) is not a hairline on its own.
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
            const hasHeight = tokens.some((t) => HAIRLINE_HEIGHT.test(t));
            const hasFill = tokens.some((t) => BORDER_FILL.test(t));
            if (hasHeight && hasFill) {
              context.report({ node: attr, messageId: "handRolledHairline" });
            }
          }
        },
      };
    },
  });
}
