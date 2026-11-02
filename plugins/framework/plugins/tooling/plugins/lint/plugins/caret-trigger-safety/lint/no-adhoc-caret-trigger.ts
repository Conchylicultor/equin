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

const CARET_TRIGGER =
  "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";
const FLOATING_SURFACE =
  "@plugins/primitives/plugins/overlay/plugins/floating-surface/web";

/**
 * Where a caret-menu PANEL can come from, and when importing it says "I am
 * rendering a caret-anchored menu" — the claim `useCaretMenu` must then back
 * with a keyboard model.
 *
 * `CaretTriggerMenu` IS the caret-menu panel, wherever it is rendered.
 * `FloatingSurface` is the focus-less anchored surface under it, which has since
 * grown consumers that are no caret menu at all (a shelf peek, a scrubber hover
 * preview, a path bar, a link hover card, a selection toolbar). It is evidence
 * only in an EDITOR file — one that reaches Lexical, the text editor, the caret
 * trigger or the DOM selection — which is where a hand-rolled caret menu lives
 * (`url-paste`'s took `caretAnchor` and Lexical's `KEY_ESCAPE_COMMAND`).
 *
 * Sources are exact specifiers, never patterns: plugin-meta/plugin-refs locates
 * a lint rule's `@plugins/…` string, so `plugin-refs-resolve` fails when the
 * barrel moves and `./equin plugin move` rewrites it. A regex here once kept
 * matching `floating-surface`'s pre-move path and caught nothing for two months.
 */
const SURFACE_SOURCES: {
  source: string;
  exports: Set<string>;
  editorOnly: boolean;
}[] = [
  {
    source: CARET_TRIGGER,
    exports: new Set(["CaretTriggerMenu"]),
    editorOnly: false,
  },
  {
    source: FLOATING_SURFACE,
    exports: new Set(["FloatingSurface"]),
    editorOnly: true,
  },
];

/** Imports that make a file an editor file (see `SURFACE_SOURCES`). */
const EDITOR_SOURCES = new Set([
  "lexical",
  "@plugins/primitives/plugins/text-editor/web",
  CARET_TRIGGER,
  "@plugins/primitives/plugins/dom/plugins/dom-selection/web",
]);
const isEditorSource = (source: string) =>
  EDITOR_SOURCES.has(source) || source.startsWith("@lexical/");

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
    // path, so they never self-match on it; `CaretTriggerMenu`'s own file takes
    // `FloatingSurface` through its barrel, but imports nothing that makes it an
    // editor file, so it needs no exemption.
    //
    // Keying on the panel rather than on a rect helper is a strengthening, not a
    // swap: it catches a hand-rolled caret menu HOWEVER it obtained its anchor —
    // including one anchored to an element rect, which never touched the old
    // `caretAnchor` evidence and slipped straight through.
    const surfaceImports: {
      node: TSESTree.Node;
      name: string;
      editorOnly: boolean;
    }[] = [];
    let sawUseCaretMenu = false;
    let isEditorFile = false;

    return {
      ImportDeclaration(node) {
        if (isEditorSource(node.source.value)) isEditorFile = true;
        const source = SURFACE_SOURCES.find(
          (s) => s.source === node.source.value,
        );
        if (!source) return;
        for (const spec of node.specifiers) {
          if (
            spec.type !== "ImportSpecifier" ||
            spec.imported.type !== "Identifier"
          )
            continue;
          if (source.exports.has(spec.imported.name)) {
            surfaceImports.push({
              node: spec,
              name: spec.imported.name,
              editorOnly: source.editorOnly,
            });
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
          for (const { node, name, editorOnly } of surfaceImports) {
            if (editorOnly && !isEditorFile) continue;
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
