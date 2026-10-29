import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** `x.registerUpdateListener(...)` — the Lexical editor-update subscription. */
function isRegisterUpdateListener(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "registerUpdateListener"
  );
}

/** `text.lastIndexOf(...)` / `text.indexOf(...)` — the hand-rolled trigger scan. */
function isIndexScan(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    (callee.property.name === "lastIndexOf" ||
      callee.property.name === "indexOf")
  );
}

/**
 * The two barrels a caret-menu PANEL can come from, and the export each one
 * contributes. Importing either says "I am rendering a caret-anchored menu";
 * `useCaretMenu` is where that menu's keyboard model comes from.
 *
 * `FloatingSurface` is here because its own charter is "a focus-less,
 * caret-anchored floating surface … for transient caret menus", and its only
 * production consumer is `CaretTriggerMenu`.
 */
const SURFACE_SOURCES: { source: RegExp; exports: Set<string> }[] = [
  {
    source: /text-editor\/plugins\/caret-trigger\/web$/,
    exports: new Set(["CaretTriggerMenu"]),
  },
  {
    source: /^@plugins\/primitives\/plugins\/floating-surface\/web$/,
    exports: new Set(["FloatingSurface"]),
  },
];

/** `useCaretMenu(...)` — the hook that owns arrows / Enter / Esc / commit. */
function isUseCaretMenu(node: TSESTree.CallExpression): boolean {
  return (
    node.callee.type === "Identifier" && node.callee.name === "useCaretMenu"
  );
}

export default createRule({
  name: "no-adhoc-caret-trigger",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolling a caret-trigger menu — deriving a menu's open-state " +
        "by scanning editor text from inside a Lexical `registerUpdateListener`, or " +
        "rendering the caret-menu panel without `useCaretMenu`'s keyboard model.",
    },
    schema: [],
    messages: {
      adhocCaretTrigger:
        "This file scans editor text for a trigger from inside a Lexical " +
        "`registerUpdateListener` — the hand-rolled caret-menu shape. Four copies of " +
        "it each carried a `dismissedRef` latch that no branch was guaranteed to " +
        "reset, so an empty block wedged the menu closed permanently. Use " +
        "`useCaretQuery` + `useCaretMenu` from " +
        "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web, which " +
        "derives open-state instead of latching it. If your trigger needs something " +
        "the hook can't express, extend the primitive rather than copying it.",
      caretSurfaceWithoutMenu:
        "`{{name}}` renders the caret-menu panel, but this file never calls " +
        "`useCaretMenu` — so the menu has no keyboard model: arrows don't move the " +
        "selection, Enter doesn't commit, and Esc / outside-press aren't wired. That " +
        "is a mouse-only menu (the `url-paste` bug). Take the whole primitive: pair a " +
        "`useCaretQuery` (trigger char) or `useForcedCaretQuery` (external open " +
        "signal, e.g. a paste or a button) with `useCaretMenu`, and commit rows " +
        "through its `commit(index)`. If your surface has nothing SELECTABLE at all " +
        "— a caret-anchored cue, not a menu — then you do not want this panel: " +
        "position it yourself inside a `ViewportOverlay`, as `page/editor`'s " +
        "pending-marks cue does.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Both halves must appear in the same file: a `registerUpdateListener` alone
    // is a legitimate subscription (markdown shortcuts, format toolbar, the
    // doc→row projection), and an `indexOf` alone is just string work. Their
    // conjunction is the scan-open-state-from-editor-updates shape.
    const listeners: TSESTree.CallExpression[] = [];
    let sawIndexScan = false;

    // The half-adoption shape: a file that renders the menu PANEL but never
    // reaches for the KEYBOARD. Rendering is the visible half, so it is the half
    // that gets copied; the keyboard model is invisible until someone presses a
    // key. The primitive's own files reach the caret-trigger barrel by relative
    // path, so they never self-match on it — but `FloatingSurface` is another
    // plugin, which they must import through its barrel, so `CaretTriggerMenu`'s
    // own file is declared in its `exempt/index.ts`.
    //
    // Keying on the panel rather than on a rect helper is a strengthening, not a
    // swap: it catches a hand-rolled caret menu HOWEVER it obtained its anchor —
    // including one anchored to an element rect, which never touched the old
    // `caretAnchor` evidence and slipped straight through.
    const surfaceImports: { node: TSESTree.Node; name: string }[] = [];
    let sawUseCaretMenu = false;

    return {
      ImportDeclaration(node) {
        const source = SURFACE_SOURCES.find((s) =>
          s.source.test(node.source.value),
        );
        if (!source) return;
        for (const spec of node.specifiers) {
          if (
            spec.type !== "ImportSpecifier" ||
            spec.imported.type !== "Identifier"
          )
            continue;
          if (source.exports.has(spec.imported.name)) {
            surfaceImports.push({ node: spec, name: spec.imported.name });
          }
        }
      },
      CallExpression(node) {
        if (isRegisterUpdateListener(node)) listeners.push(node);
        else if (isIndexScan(node)) sawIndexScan = true;
        if (isUseCaretMenu(node)) sawUseCaretMenu = true;
      },
      "Program:exit"() {
        if (sawIndexScan) {
          for (const node of listeners) {
            context.report({ node, messageId: "adhocCaretTrigger" });
          }
        }
        if (!sawUseCaretMenu) {
          for (const { node, name } of surfaceImports) {
            context.report({
              node,
              messageId: "caretSurfaceWithoutMenu",
              data: { name },
            });
          }
        }
      },
    };
  },
});
