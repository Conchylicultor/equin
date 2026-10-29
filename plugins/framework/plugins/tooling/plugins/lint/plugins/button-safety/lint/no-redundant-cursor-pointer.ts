import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The app's base layer (`ui-kit/web/theme/app.css`) gives every real control the
 * pointer cursor — `<button>`, anything with `role="button"`, `<summary>`,
 * `<select>`, the clickable `<input>` types, and a `<label>` wrapping a checkbox
 * or radio. Writing `cursor-pointer` on one of those again does nothing.
 *
 * That is worth a rule rather than a note, because the class is invisible once
 * it is wrong: it costs nothing, it looks like care, and it was hand-written on
 * ~30 controls back when the base rule did not exist. Left alone the copies grow
 * back one call site at a time, and then the base rule looks optional.
 *
 * It only fires on elements a syntactic rule can be SURE about — a literal tag,
 * a literal `role`/`as`, or `Button`/`IconButton` by name. A `<Row onClick>`
 * renders a `<button>` too, but only its own props say so, so the rule stays
 * quiet there rather than guessing.
 *
 * A control that genuinely wants the arrow keeps `cursor-default`, which is a
 * utility and so still beats the base layer.
 */

/** Tags whose element the base rule reaches by name alone. */
const COVERED_TAGS = new Set(["button", "summary", "select"]);

/** Components that render one of the above and nothing else. */
const COVERED_COMPONENTS = new Set(["Button", "IconButton"]);

/** `<input type=…>` values the base rule covers. */
const COVERED_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** The `<input type=…>` values a `<label>` around them is covered for. */
const LABELLED_INPUT_TYPES = new Set(["checkbox", "radio"]);

/** `cursor-pointer`, alone or behind any chain of variants (`hover:`, `md:`, …). */
const CURSOR_POINTER = /(?:^|\s)(?:[\w-]+:)*cursor-pointer(?:\s|$)/;

/** The literal string value of attribute `name`, or undefined if not literal. */
function literalAttr(
  el: TSESTree.JSXOpeningElement,
  name: string,
): string | undefined {
  for (const attr of el.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    if (attr.name.type !== "JSXIdentifier" || attr.name.name !== name) continue;
    const value = attr.value;
    if (value?.type === "Literal" && typeof value.value === "string")
      return value.value;
    return undefined;
  }
  return undefined;
}

/** The tag as written: `button`, `Button`, or undefined for a member/namespace tag. */
function tagName(el: TSESTree.JSXOpeningElement): string | undefined {
  return el.name.type === "JSXIdentifier" ? el.name.name : undefined;
}

/** Does this subtree contain a checkbox/radio `<input>`? */
function containsLabelledInput(node: TSESTree.Node): boolean {
  if (node.type === "JSXElement") {
    const tag = tagName(node.openingElement);
    if (tag === "input") {
      const type = literalAttr(node.openingElement, "type");
      if (type !== undefined && LABELLED_INPUT_TYPES.has(type)) return true;
    }
  }
  const children =
    node.type === "JSXElement"
      ? node.children
      : node.type === "JSXFragment"
        ? node.children
        : node.type === "JSXExpressionContainer"
          ? [node.expression]
          : [];
  for (const child of children) {
    if (containsLabelledInput(child as TSESTree.Node)) return true;
  }
  return false;
}

/** Why the base layer already covers this element, or undefined if it does not. */
function coveredBy(el: TSESTree.JSXOpeningElement): string | undefined {
  const tag = tagName(el);

  if (literalAttr(el, "role") === "button") return 'role="button"';

  const as = literalAttr(el, "as");
  if (as !== undefined && COVERED_TAGS.has(as)) return `as="${as}"`;

  if (tag !== undefined && COVERED_TAGS.has(tag)) return `<${tag}>`;
  if (tag !== undefined && COVERED_COMPONENTS.has(tag))
    return `<${tag}> (a <button>)`;

  if (tag === "input") {
    const type = literalAttr(el, "type");
    if (type !== undefined && COVERED_INPUT_TYPES.has(type))
      return `<input type="${type}">`;
  }

  // A <label> is covered only when it actually wraps a checkbox / radio, which
  // is what `label:has(input…)` in the base layer keys on.
  if (tag === "label" || as === "label") {
    const el2 = el.parent;
    if (el2.type === "JSXElement" && containsLabelledInput(el2))
      return "a <label> around a checkbox / radio";
  }

  return undefined;
}

/** Every string literal inside `node` (plain strings and template chunks). */
function stringsIn(node: TSESTree.Node, out: string[]): void {
  if (node.type === "Literal") {
    if (typeof node.value === "string") out.push(node.value);
    return;
  }
  if (node.type === "TemplateElement") {
    out.push(node.value.cooked ?? node.value.raw);
    return;
  }
  for (const key of Object.keys(node) as (keyof typeof node)[]) {
    if (key === "parent") continue;
    const value = node[key] as unknown;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "type" in item)
          stringsIn(item as TSESTree.Node, out);
      }
    } else if (value && typeof value === "object" && "type" in value) {
      stringsIn(value as TSESTree.Node, out);
    }
  }
}

export default createRule({
  name: "no-redundant-cursor-pointer",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-written cursor-pointer on controls the base layer already covers (button, role=button, summary, select, clickable inputs, a label around a checkbox/radio).",
    },
    schema: [],
    messages: {
      redundant:
        "`cursor-pointer` on {{what}} does nothing — the base layer in `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css` already gives every control the pointer cursor. Delete the class. (To opt OUT — a control that is a static readout — write `cursor-default`, which is a utility and still wins.)",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXAttribute(node: TSESTree.JSXAttribute) {
        if (
          node.name.type !== "JSXIdentifier" ||
          node.name.name !== "className"
        )
          return;
        const what = coveredBy(node.parent);
        if (what === undefined) return;
        const value = node.value;
        if (!value) return;

        const strings: string[] = [];
        stringsIn(value, strings);
        if (!strings.some((s) => CURSOR_POINTER.test(s))) return;

        context.report({ node, messageId: "redundant", data: { what } });
      },
    };
  },
});
