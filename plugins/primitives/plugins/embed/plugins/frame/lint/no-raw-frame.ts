import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-frame
 *
 * Every frame goes through the one framing primitive
 * (`@plugins/primitives/plugins/embed/plugins/frame/web`): `ContentFrame`
 * (untrusted content, on the content host), `ForeignFrame` (another site's
 * page, classified first), `InlineFrame` (an opaque `srcdoc`), `PdfFrame` (a
 * served PDF) or `AppFrame` (the app itself). A raw frame is how untrusted
 * content ends up running on an app origin with the owner's authority: an
 * unsandboxed `<iframe>`, or one granted `allow-same-origin`, on our own
 * origin is the app itself to every check (Trust boundaries, Phase 3).
 *
 * Flags the JSX elements `<iframe>`, `<frame>`, `<object>`, `<embed>`; a
 * `document.createElement("iframe" | "frame" | "object" | "embed")`; and an
 * assignment to a `.srcdoc` / `.sandbox` property. Syntactic: a tag name held
 * in a variable is not seen — the rule closes the obvious spellings. The
 * primitive's own file is its sanctioned exemption.
 */

const createRule = lintRuleCreator(import.meta.url);

const FRAME_TAGS = new Set(["iframe", "frame", "object", "embed"]);
const FRAME_PROPS = new Set(["srcdoc", "sandbox"]);

function literalText(node: TSESTree.Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

export default createRule({
  name: "no-raw-frame",
  meta: {
    type: "problem",
    docs: {
      description:
        "Frame only through the framing primitive (ContentFrame / ForeignFrame / InlineFrame / PdfFrame / AppFrame), never a raw <iframe>, <frame>, <object> or <embed>.",
    },
    schema: [],
    messages: {
      rawFrame:
        "A raw <{{tag}}> can run untrusted content on an app origin with the owner's " +
        "authority (an unsandboxed or `allow-same-origin` frame on our origin IS the app). " +
        "Frame through @plugins/primitives/plugins/embed/plugins/frame/web: ContentFrame " +
        "(untrusted content — declare its route `access: { content }`, frame its " +
        "contentPath), ForeignFrame (another site's URL), InlineFrame (an HTML string, " +
        "opaque), PdfFrame (a served PDF) or AppFrame (the app itself at an in-app path).",
      frameProp:
        "Writing `.{{prop}}` builds a frame by hand. Frame through " +
        "@plugins/primitives/plugins/embed/plugins/frame/web instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        if (node.name.type !== "JSXIdentifier") return;
        const tag = node.name.name;
        if (!FRAME_TAGS.has(tag)) return;
        context.report({ node, messageId: "rawFrame", data: { tag } });
      },
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "createElement"
        ) {
          return;
        }
        const tag = literalText(node.arguments[0])?.toLowerCase();
        if (tag === undefined || !FRAME_TAGS.has(tag)) return;
        context.report({ node, messageId: "rawFrame", data: { tag } });
      },
      AssignmentExpression(node: TSESTree.AssignmentExpression) {
        const target = node.left;
        if (
          target.type !== "MemberExpression" ||
          target.computed ||
          target.property.type !== "Identifier" ||
          !FRAME_PROPS.has(target.property.name)
        ) {
          return;
        }
        context.report({
          node,
          messageId: "frameProp",
          data: { prop: target.property.name },
        });
      },
    };
  },
});
