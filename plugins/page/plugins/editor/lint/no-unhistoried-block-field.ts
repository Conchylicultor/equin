import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-unhistoried-block-field
 *
 * Every editing surface on screen belongs to SOME undo history. In the page
 * body that is not automatic, and getting it wrong is silent.
 *
 * The block list declares `data-undo-owner="surface"` (`surfaceUndoProps`, in
 * `web/components/block-editor.tsx`), because the page deliberately keeps ONE
 * chronological document stack instead of a per-block Lexical history. Undo
 * resolution is by nearest declaring ancestor, so that declaration covers every
 * raw `<textarea>` / `<input>` / `contenteditable` rendered anywhere beneath
 * it. A field that declares nothing therefore does not keep its own history —
 * it hands `mod+z` to the surface stack, which `preventDefault()`s the key, and
 * the browser's own field history (the one that undoes a paste correctly) never
 * runs. What the user gets instead is an unrelated earlier document edit
 * reversed while they are typing.
 *
 * That bug shipped twice, byte for byte (`code-block`, `math/equation`), and
 * three more block fields carried the routing half of it. Nothing caught any of
 * them: the editor's undo test enforces "every mutation records one entry", and
 * a field that records nothing while you type is invisible to it. This rule is
 * the check that was missing.
 *
 * There are exactly two right answers, and the message names both:
 *
 *  - **Persisted block text** → `<BlockTextArea>` from
 *    `@plugins/page/plugins/editor/web`, which records each typing run onto the
 *    document stack synchronously and persists on its own timer.
 *  - **Transient chrome** (a URL prompt, a search box — nothing the page
 *    stores) → spread `localUndoProps` from
 *    `@plugins/primitives/plugins/undo-redo/web`, handing `mod+z` back to the
 *    browser.
 *
 * WHAT IS FLAGGED. Only INTRINSIC elements — a lowercase JSX name is a real DOM
 * node with a real browser history to lose. `<RichTextPlugin contentEditable={…}>`
 * is a Lexical render prop, not a DOM attribute, and `<ContentEditable>` is a
 * component that carries its own declaration; neither is this rule's business.
 * An `<input>` counts only when its `type` is statically absent (defaulting to
 * `text`) or a literal text-ish type — mirroring `resolveUndoOwner`'s own set.
 * A checkbox or file picker has no text history to protect, and forcing a
 * `local` marker onto one would silence ⌘Z right after ticking it, which is the
 * one moment the user most wants it. A computed `type` is left alone for the
 * same reason: it may well be a checkbox.
 *
 * SCOPE. A contributed rule is enabled repo-wide, but only the page body
 * declares a surface-undo region around its fields — a raw textarea is ordinary
 * everywhere else. So the rule checks the filename and stays silent outside
 * `plugins/page/` and outside a `web/` runtime. Test and e2e files are already
 * exempt (NON_APP_FILE_GLOBS); `<BlockTextArea>`'s own implementation is
 * exempted by path in the lint barrel.
 *
 * AST-only and self-contained: a contributed lint rule file is loaded by jiti,
 * which cannot resolve the `@plugins/*` tsconfig alias, so it may not import
 * across plugins. The attribute name, the marker's identifier and the text-ish
 * type set below are therefore INLINED copies — the source of truth for all
 * three is
 * `plugins/primitives/plugins/undo-redo/web/internal/undo-owner.ts`.
 */

const createRule = lintRuleCreator(import.meta.url);

/**
 * The app that renders its fields inside a surface-undo region. Combined with
 * `WEB_RUNTIME` below, since only browser code renders JSX that a user types
 * into. Path-separator-agnostic so the check holds if a caller ever hands
 * ESLint Windows-shaped filenames.
 */
const OWNING_APP = "plugins/page/";
const WEB_RUNTIME = "/web/";

/** Copy of `UNDO_OWNER_ATTR` (see the file note above). */
const UNDO_OWNER_ATTR = "data-undo-owner";
/** Copy of the exported marker's identifier (see the file note above). */
const LOCAL_MARKER = "localUndoProps";

/**
 * Copy of `TEXT_INPUT_TYPES` — the input types the browser keeps an undo stack
 * for (see the file note above). Deliberately narrower than "editable": a
 * checkbox, radio or file picker has no text history to protect.
 */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

/** The element already declares who owns its `mod+z`. */
function declaresUndoOwner(node: TSESTree.JSXOpeningElement): boolean {
  return node.attributes.some((attr) => {
    // `{...localUndoProps}` — the sanctioned spelling.
    if (attr.type === "JSXSpreadAttribute")
      return (
        attr.argument.type === "Identifier" &&
        attr.argument.name === LOCAL_MARKER
      );
    // A hand-written `data-undo-owner=…` also declares. `resolveUndoOwner`
    // throws at runtime on a value that is neither owner, so a wrong one is
    // loud rather than silent — this rule need not re-check it.
    return (
      attr.name.type === "JSXIdentifier" && attr.name.name === UNDO_OWNER_ATTR
    );
  });
}

/** The static value of a JSX attribute, when it has one. */
function literalAttrValue(
  node: TSESTree.JSXOpeningElement,
  attrName: string,
): { present: false } | { present: true; value: string | null } {
  for (const attr of node.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    if (attr.name.type !== "JSXIdentifier" || attr.name.name !== attrName)
      continue;
    const value = attr.value;
    if (value?.type === "Literal" && typeof value.value === "string")
      return { present: true, value: value.value };
    if (
      value?.type === "JSXExpressionContainer" &&
      value.expression.type === "Literal" &&
      typeof value.expression.value === "string"
    )
      return { present: true, value: value.expression.value };
    // Present but computed — not statically knowable.
    return { present: true, value: null };
  }
  return { present: false };
}

/**
 * Is this element an editing host? `<div contentEditable>` and
 * `contentEditable="true"` are; `contentEditable={false}` / `"false"` are not,
 * and a computed value is treated as one — the marker is the right answer
 * whenever it might be.
 */
function isEditingHost(node: TSESTree.JSXOpeningElement): boolean {
  for (const attr of node.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    if (
      attr.name.type !== "JSXIdentifier" ||
      attr.name.name !== "contentEditable"
    )
      continue;
    const value = attr.value;
    // Bare `contentEditable` — shorthand for `={true}`.
    if (value === null) return true;
    if (value.type === "Literal") return value.value !== "false";
    if (value.type === "JSXExpressionContainer") {
      const inner = value.expression;
      if (inner.type === "Literal")
        return inner.value !== false && inner.value !== "false";
      return true;
    }
    return true;
  }
  return false;
}

/** `true` for an `<input>` the browser keeps a text history for. */
function isTextInput(node: TSESTree.JSXOpeningElement): boolean {
  const type = literalAttrValue(node, "type");
  // No `type` at all is `type="text"` — the default, and the shape a hand-rolled
  // block field actually takes.
  if (!type.present) return true;
  if (type.value === null) return false;
  return TEXT_INPUT_TYPES.has(type.value);
}

export default createRule({
  name: "no-unhistoried-block-field",
  meta: {
    type: "problem",
    docs: {
      description:
        "no raw text-editing element in a page block without an undo owner " +
        "(the block list declares `surface`, so an undeclared field loses the " +
        "browser's own history and rewinds the document instead)",
    },
    schema: [],
    messages: {
      unhistoriedField:
        "`<{{element}}>` in a page block declares no undo owner. The block list " +
        "around it declares `surface`, so ⌘Z here is swallowed by the document " +
        "stack and the browser's own history for this field never runs — a paste " +
        "becomes un-undoable and an unrelated block edit is reversed instead. " +
        "For text the page PERSISTS, render `<BlockTextArea>` from " +
        "`@plugins/page/plugins/editor/web`, which records each typing run onto " +
        "the document stack. For a TRANSIENT field (a URL prompt, a search box), " +
        "spread `localUndoProps` from " +
        "`@plugins/primitives/plugins/undo-redo/web` to hand ⌘Z back to the " +
        "browser.",
      unhistoriedContentEditable:
        "A `contentEditable` `<{{element}}>` in a page block declares no undo " +
        "owner. The block list around it declares `surface`, so ⌘Z here drives " +
        "the document stack instead of this editing host. Render " +
        "`<BlockTextArea>` from `@plugins/page/plugins/editor/web` for text the " +
        "page persists, or spread `localUndoProps` from " +
        "`@plugins/primitives/plugins/undo-redo/web` for an editor that keeps " +
        "its own history.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Outside the page body's surface-undo region a raw editable is ordinary
    // code. Bail once, up front, rather than per node.
    const filename = context.filename.replaceAll("\\", "/");
    if (!filename.includes(OWNING_APP) || !filename.includes(WEB_RUNTIME))
      return {};

    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        // Intrinsic elements only: a lowercase name is a real DOM node. A
        // component (`<Input>`, `<ContentEditable>`) routes its props somewhere
        // this rule cannot see, and declares its owner at its own definition.
        if (node.name.type !== "JSXIdentifier") return;
        const element = node.name.name;
        if (element !== element.toLowerCase()) return;
        if (declaresUndoOwner(node)) return;

        if (isEditingHost(node)) {
          context.report({
            node,
            messageId: "unhistoriedContentEditable",
            data: { element },
          });
          return;
        }

        if (
          element === "textarea" ||
          (element === "input" && isTextInput(node))
        )
          context.report({
            node,
            messageId: "unhistoriedField",
            data: { element },
          });
      },
    };
  },
});
