import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * `LexicalEditor.read(fn)` is not a read. It runs `$commitPendingUpdates`
 * first (`lexical@0.44.0 Lexical.dev.mjs`, `read()`), so called from inside an
 * update — any command listener, transform or nested helper a listener reaches
 * — it COMMITS the in-flight update halfway through. Whatever the update does
 * after that lands on a state Lexical already considers committed: never
 * reconciled to the DOM, never seen by the collab binding, so never saved and
 * never undoable, until some later update happens to carry it.
 *
 * The page editor shipped exactly that: Backspace / Delete over a selection
 * inside one block did nothing, because the keyboard plugin's caret read (a
 * HIGH-priority listener on the key command) measured the selection's focus
 * through a helper calling `editor.read()`. The delete then ran on the
 * committed state — the text vanished only on the next click, came back on
 * reload, and Cmd+Z could not restore it.
 *
 * `editor.getEditorState().read(fn, { editor })` is the same read with the
 * editor active (what `$getNearestNodeFromDOMNode` and friends need), minus the
 * flush — and it reads the COMMITTED state, which is the one the DOM shows.
 * Type-aware, so it matches the editor by type, not by variable name.
 */
export default createRule({
  name: "no-flushing-editor-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow LexicalEditor.read(): it flushes pending updates, so from inside an update it commits that update halfway through. Use editor.getEditorState().read(fn, { editor }).",
    },
    schema: [],
    messages: {
      flushingRead:
        "`LexicalEditor.read()` flushes pending updates first — called inside an update (a command listener, a transform, any helper they reach) it commits that update halfway through, and the rest of it is never rendered or saved. Use `editor.getEditorState().read(fn, { editor })`: the same read with the editor active, without the flush.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "read"
        )
          return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(callee.object);
        const type = checker.getTypeAtLocation(tsNode);
        const name = (type.getSymbol() ?? type.aliasSymbol)?.getName();
        if (name !== "LexicalEditor") return;
        context.report({ node, messageId: "flushingRead" });
      },
    };
  },
});
