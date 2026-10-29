import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A floating surface leaves with motion.
 *
 * A floating surface animates its own arrival (`Surface` overlay / float
 * wears `surface-enter`) and its own size changes (`useSizeMotion`), but it
 * cannot animate its departure: under `{open && <Pin layer="float">…}` it is
 * gone in the commit that closes it. `<Presence>` keeps it drawn until its
 * exit has run, so the conditional belongs inside one:
 * `<Presence>{open ? <Pin key="card" …/> : null}</Presence>`.
 *
 * WHAT IS A FLOATING SURFACE — read off the JSX, no types:
 *   - `<Surface>` with `level="overlay"` or `"float"`,
 *   - `<ViewportOverlay>`,
 *   - a `<Pin>` / `<Placed>` / `<Layer>` with `layer="float"` or `"overlay"`
 *     that holds one of the above in the same JSX (a floating card's slot).
 *     A floating pin holding only controls (a photo's arrows, a label) is
 *     not a surface: it comes and goes with what it decorates.
 *
 * WHAT IS FLAGGED — such an element as the markup of a JSX conditional:
 *   `x && <…>`, `x ? <…> : null`, `x ? null : <…>` (and `undefined` / `false`
 *   for the empty branch) — unless the conditional is the direct child of a
 *   `<Presence>`.
 *
 * NOT SEEN (accepted false negatives): a composite component that renders
 * the surface inside (`{open && <PlaceCard/>}`, or a floating `<Pin>` around
 * one) — its surface still enters and resizes with motion; an early
 * `if (!open) return null`.
 *
 * A genuine exception (a surface whose removal must be instant) is declared
 * by the plugin that owns the file, in its `exempt/index.ts`.
 */

type MessageIds = "unanimatedSurfaceExit";

const LAYERED = new Set(["Pin", "Placed", "Layer"]);
const FLOATING_LAYERS = new Set(["float", "overlay"]);
const FLOATING_LEVELS = new Set(["overlay", "float"]);

function elementName(el: TSESTree.JSXOpeningElement): string | null {
  if (el.name.type === "JSXIdentifier") return el.name.name;
  if (el.name.type === "JSXMemberExpression") return el.name.property.name;
  return null;
}

/** A string attribute's literal value (`layer="float"`, `layer={"float"}`). */
function literalAttr(
  el: TSESTree.JSXOpeningElement,
  name: string,
): string | null {
  const a = el.attributes.find(
    (x): x is TSESTree.JSXAttribute =>
      x.type === "JSXAttribute" &&
      x.name.type === "JSXIdentifier" &&
      x.name.name === name,
  );
  const v = a?.value;
  if (!v) return null;
  if (v.type === "Literal" && typeof v.value === "string") return v.value;
  if (
    v.type === "JSXExpressionContainer" &&
    v.expression.type === "Literal" &&
    typeof v.expression.value === "string"
  ) {
    return v.expression.value;
  }
  return null;
}

function isSurface(el: TSESTree.JSXOpeningElement): string | null {
  const name = elementName(el);
  if (name === "ViewportOverlay") return name;
  if (name === "Surface") {
    const level = literalAttr(el, "level");
    return level !== null && FLOATING_LEVELS.has(level)
      ? `<Surface level="${level}">`
      : null;
  }
  return null;
}

/** A floating `<Surface>` / `<ViewportOverlay>` anywhere under `node`'s JSX. */
function holdsSurface(node: TSESTree.JSXElement): boolean {
  for (const child of node.children) {
    if (child.type === "JSXElement") {
      if (isSurface(child.openingElement) !== null || holdsSurface(child)) {
        return true;
      }
    } else if (
      child.type === "JSXExpressionContainer" &&
      child.expression.type === "JSXElement"
    ) {
      const inner = child.expression;
      if (isSurface(inner.openingElement) !== null || holdsSurface(inner)) {
        return true;
      }
    }
  }
  return false;
}

function floatingSurface(node: TSESTree.Node): string | null {
  if (node.type !== "JSXElement") return null;
  const el = node.openingElement;
  const surface = isSurface(el);
  if (surface !== null) return surface;
  const name = elementName(el);
  if (name === null || !LAYERED.has(name)) return null;
  const layer = literalAttr(el, "layer");
  return layer !== null && FLOATING_LAYERS.has(layer) && holdsSurface(node)
    ? `<${name} layer="${layer}">`
    : null;
}

function isEmptyBranch(node: TSESTree.Node): boolean {
  return (
    (node.type === "Literal" &&
      (node.value === null || node.value === false)) ||
    (node.type === "Identifier" && node.name === "undefined")
  );
}

/** The conditional is `<Presence>{…}</Presence>`'s child. */
function insidePresence(node: TSESTree.Node): boolean {
  const container = node.parent;
  if (container?.type !== "JSXExpressionContainer") return false;
  const owner = container.parent;
  return (
    owner?.type === "JSXElement" &&
    elementName(owner.openingElement) === "Presence"
  );
}

export default createRule<[], MessageIds>({
  name: "no-unanimated-surface-exit",
  meta: {
    type: "problem",
    docs: {
      description:
        "A floating surface mounted by a conditional must sit inside <Presence>, which plays its exit, never vanish in one frame.",
    },
    schema: [],
    messages: {
      unanimatedSurfaceExit:
        "This conditional mounts a floating surface ({{surface}}) that vanishes in one frame when it closes. " +
        "Put the conditional inside `<Presence>` (primitives/css/motion), which keeps the surface drawn until its exit has run: " +
        '`<Presence>{open ? <Pin key="card" …/> : null}</Presence>`. ' +
        "See plugins/primitives/plugins/css/plugins/motion/CLAUDE.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    const check = (node: TSESTree.Node, markup: TSESTree.Node) => {
      const surface = floatingSurface(markup);
      if (surface === null || insidePresence(node)) return;
      context.report({
        node,
        messageId: "unanimatedSurfaceExit",
        data: { surface },
      });
    };
    return {
      LogicalExpression(node) {
        // The outermost `&&` of a chain only: `a && b && <X/>` once.
        if (node.operator !== "&&") return;
        if (
          node.parent.type === "LogicalExpression" &&
          node.parent.operator === "&&"
        )
          return;
        check(node, node.right);
      },
      ConditionalExpression(node) {
        if (isEmptyBranch(node.alternate)) check(node, node.consequent);
        else if (isEmptyBranch(node.consequent)) check(node, node.alternate);
      },
    };
  },
});
