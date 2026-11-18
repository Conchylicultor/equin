/**
 * Bans importing the toast stack's custom-content path (`useShowCustomToast`)
 * outside `shell/notifications`.
 *
 * Every toast is a notification: `useToast` (`@plugins/shell/plugins/notifications/web`)
 * shows it AND records it in the notification history, so a toast the user had
 * no time to read is still in the bell. The toast plugin is only the stack
 * that places it; a toast raised through it directly would be shown and
 * written nowhere — the gap `research/2026-11-18-global-unified-recorded-toast.md`
 * closed. `shell/notifications` (the one caller) declares its exemption in its
 * own `exempt/index.ts`.
 *
 * Checked: `import` (type-only included) and `export … from` naming it.
 * Self-contained by necessity — the ESLint config loads rule files through
 * jiti, which cannot resolve `@plugins/*`.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const TOAST_WEB = "@plugins/shell/plugins/toast/web";
const BANNED = "useShowCustomToast";

export default createRule({
  name: "no-direct-custom-toast",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raising a toast through the toast stack directly — use `useToast` from `@plugins/shell/plugins/notifications/web`, which also records it in the notification history.",
    },
    schema: [],
    messages: {
      direct:
        "`useShowCustomToast` raises a toast that is recorded nowhere. Use `useToast` from " +
        "`@plugins/shell/plugins/notifications/web`: it shows the toast and records it in the " +
        "notification history (an Undo or other closure goes in `liveAction`; a small " +
        'acknowledgement uses `category: "confirmations"`).',
    },
  },
  defaultOptions: [],
  create(context) {
    const check = (
      source: TSESTree.Literal,
      specifiers: readonly (TSESTree.ImportClause | TSESTree.ExportSpecifier)[],
    ): void => {
      if (source.value !== TOAST_WEB) return;
      for (const s of specifiers) {
        const imported =
          s.type === "ImportSpecifier"
            ? s.imported
            : s.type === "ExportSpecifier"
              ? s.local
              : null;
        if (
          imported !== null &&
          (imported.type === "Identifier" ? imported.name : imported.value) ===
            BANNED
        ) {
          context.report({ node: s, messageId: "direct" });
        }
      }
    };
    return {
      ImportDeclaration(node) {
        check(node.source, node.specifiers);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) check(node.source, node.specifiers);
      },
    };
  },
});
