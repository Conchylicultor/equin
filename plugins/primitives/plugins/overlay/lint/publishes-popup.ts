/**
 * publishes-popup
 *
 * Every popup (dialog, sheet, popover, menu, select, …) publishes its open
 * state to `popup-open`: the enclosing `PopupOpenScope` (hover-revealed chrome
 * stays revealed) and the page-wide signal (`anyPopupOpen` — the hints engine
 * holds a tip back, and the reload policy reads it as "the user is engaged",
 * so a quiet upgrade never reloads under an open dialog).
 *
 * The ui-kit `Root` wrappers do it through `usePopupOpenMirror`. A module that
 * imports a popup library's root primitive (`@base-ui/react/dialog`, `/popover`,
 * `/menu`, `/select`, …) must therefore call `usePopupOpenMirror` or
 * `usePublishOpenPopup` itself — in practice only ui-kit does; everything else
 * uses ui-kit's `Dialog` / `Popover` / `DropdownMenu` / `Select`, which publish.
 *
 * Design: research/2026-11-17-global-lossless-reload.md ("Enforcement").
 * Tooltips and hover previews are not popups the user is engaged with
 * (`tooltip`, `preview-card` are not listed).
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** base-ui primitives that open a popup the user works in. */
const POPUP_MODULES = new Set(
  [
    "alert-dialog",
    "autocomplete",
    "combobox",
    "context-menu",
    "dialog",
    "menu",
    "menubar",
    "navigation-menu",
    "popover",
    "select",
  ].map((m) => `@base-ui/react/${m}`),
);

const PUBLISHERS = new Set(["usePopupOpenMirror", "usePublishOpenPopup"]);

export default createRule({
  name: "publishes-popup",
  meta: {
    type: "problem",
    docs: {
      description:
        "A module rendering a popup library's root primitive must publish its open state to popup-open (usePopupOpenMirror / usePublishOpenPopup) — use ui-kit's Dialog / Popover / DropdownMenu / Select.",
    },
    schema: [],
    messages: {
      unpublished:
        "`{{source}}` opens a popup this module never publishes to popup-open: the page cannot tell it is open " +
        "(hover chrome collapses under it, a quiet reload may run while it is open). Use ui-kit's Dialog / Sheet / Popover / " +
        "DropdownMenu / Select, or call `usePopupOpenMirror` / `usePublishOpenPopup` with its open state.",
    },
  },
  defaultOptions: [],
  create(context) {
    const imports: TSESTree.ImportDeclaration[] = [];
    let publishes = false;
    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        if (POPUP_MODULES.has(node.source.value)) imports.push(node);
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          PUBLISHERS.has(node.callee.name)
        )
          publishes = true;
      },
      "Program:exit"() {
        if (publishes) return;
        for (const node of imports)
          context.report({
            node,
            messageId: "unpublished",
            data: { source: node.source.value },
          });
      },
    };
  },
});
