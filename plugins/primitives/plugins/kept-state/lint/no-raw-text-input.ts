import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-text-input
 *
 * Text is typed only into the text-input primitives — ui-kit `Input` /
 * `Textarea` (`bare` for a host-styled field), the `TextEditor` and its
 * composer — whose required `keep` prop makes every field decide whether
 * what is typed survives a reload and a tab switch (a `useKept` binding) or
 * is throwaway (`transient("<why>")`). A raw field skips that decision, and
 * its half-typed text is lost on the next remount (tab residency unmounts
 * hidden tabs). Design: research/2026-11-17-global-lossless-reload.md.
 *
 * Flags `<textarea>`, an `<input>` whose `type` is absent, a text type
 * (text / search / email / url / tel / password) or not a literal, and a
 * `contentEditable` attribute on a DOM element that is not literally false. Non-text inputs
 * (checkbox, file, range, date, …) are not typed text and pass.
 */

const createRule = lintRuleCreator(import.meta.url);

const TEXT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
]);

function attr(
  node: TSESTree.JSXOpeningElement,
  name: string,
): TSESTree.JSXAttribute | null {
  for (const a of node.attributes) {
    if (
      a.type === "JSXAttribute" &&
      a.name.type === "JSXIdentifier" &&
      a.name.name === name
    )
      return a;
  }
  return null;
}

/** The attribute's literal string value, `null` when absent-valued, `undefined` when dynamic. */
function literalValue(
  a: TSESTree.JSXAttribute,
): string | boolean | null | undefined {
  const v = a.value;
  if (v === null) return true;
  if (v.type === "Literal")
    return typeof v.value === "string" ? v.value : undefined;
  if (v.type === "JSXExpressionContainer") {
    const e = v.expression;
    if (e.type === "Literal") {
      if (typeof e.value === "string" || typeof e.value === "boolean")
        return e.value;
      return undefined;
    }
    if (e.type === "TemplateLiteral" && e.expressions.length === 0)
      return e.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

export default createRule({
  name: "no-raw-text-input",
  meta: {
    type: "problem",
    docs: {
      description:
        "Type text only into the text-input primitives (ui-kit Input / Textarea, TextEditor), whose required `keep` decides whether the text survives a reload.",
    },
    schema: [],
    messages: {
      rawField:
        "A raw <{{tag}}> skips the keep decision: its half-typed text is lost on reload and on a tab switch. " +
        "Use ui-kit `Input` / `Textarea` (`bare` for a host-styled field) or `TextEditor`, with " +
        '`keep={useKept(…)}` (kept-state) or `keep={transient("<why>")}`.',
      contentEditable:
        "A contentEditable surface skips the keep decision: what is typed is lost on reload. " +
        "Use a text-input primitive (ui-kit Input / Textarea, TextEditor), or keep its content as state the primitive owns.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        // `<input>`, or a DOM element through a namespace (`<motion.input>`).
        const tag =
          node.name.type === "JSXIdentifier"
            ? node.name.name
            : node.name.type === "JSXMemberExpression"
              ? node.name.property.name
              : null;
        if (tag === null) return;
        if (tag === "textarea") {
          context.report({ node, messageId: "rawField", data: { tag } });
        } else if (tag === "input") {
          const type = attr(node, "type");
          const value = type === null ? "text" : literalValue(type);
          if (
            typeof value !== "string" ||
            value === "" ||
            TEXT_TYPES.has(value.toLowerCase())
          )
            context.report({ node, messageId: "rawField", data: { tag } });
        }
        // A DOM element only: a component's `contentEditable` prop (Lexical's
        // `PlainTextPlugin contentEditable={<ContentEditable/>}`) is not one.
        if (!/^[a-z]/.test(tag)) return;
        const ce = attr(node, "contentEditable");
        if (ce !== null) {
          const value = literalValue(ce);
          if (value !== false && value !== "false")
            context.report({ node: ce, messageId: "contentEditable" });
        }
      },
    };
  },
});
