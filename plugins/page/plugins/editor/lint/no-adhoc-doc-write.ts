import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ASTUtils, type TSESTree } from "@typescript-eslint/utils";

/**
 * no-adhoc-doc-write
 *
 * A block's content lives in ONE canonical `Y.Doc` per block, held by its
 * `BlockDocOwner` (`web/internal/collab-session.ts`). Exactly three transaction
 * origins may reach that doc, and the run tracker's whole classification is
 * stated over them: the transport provider (a server apply or a seed), the
 * replay origin (`TEXT_REPLAY_ORIGIN`, a data undo entry replaying), and the
 * binding, relayed verbatim (the user typing). A fourth writer — some module
 * calling `applyUpdate(owner.doc, …)` under an origin of its own — would be
 * read by the tracker as the user typing (a run opened and recorded for an
 * edit nobody typed), by the transport as bytes to flush, and by every
 * mounted binding as a remote change, with no entry anywhere that could undo
 * it. So a write onto an owner's doc is only ever legal from the modules that
 * ARE those three origins:
 *
 *  - `web/internal/block-text-write.ts` — the replay host (host A);
 *  - `web/internal/live-state-yjs-provider.ts` and `local-yjs-provider.ts` —
 *    the transport providers;
 *  - `web/internal/binding-replica.ts` — the relay that carries the binding's
 *    transactions onto the canonical.
 *
 * Those four are exempted by PATH in the lint barrel. This rule flags every
 * other `applyUpdate(<doc>, …)` / `Y.applyUpdate(<doc>, …)` call whose first
 * argument is an owner-shaped doc: a `.doc` member read off something that is
 * not a call (`owner.doc`, `this.doc`, `session.owner.doc`,
 * `blockDocOwnerOf(id)?.doc`), or a local whose declaration binds one
 * (resolved through the scope, so a `doc` minted in one function is never
 * confused with an owner's read in another). A doc minted in place
 * (`new Doc()`, `runsToXmlText(runs).doc` — a headless replica, never an
 * owner's) is untouched: splicing a throwaway doc is what the replay hosts do,
 * and what the tests do.
 *
 * AST-only and self-contained: a contributed lint rule file is loaded by jiti,
 * which cannot resolve the `@plugins/*` tsconfig alias, so it may not import
 * across plugins.
 */

const createRule = lintRuleCreator(import.meta.url);

const APPLY_UPDATE = "applyUpdate";
/** The registry read that hands back a block's owner (`collab-session.ts`). */
const OWNER_LOOKUP = "blockDocOwnerOf";

/** `x.doc` / `x?.doc` where `x` is not a call — an owner-shaped doc read. */
function isOwnerDocMember(node: TSESTree.Node): boolean {
  if (node.type === "ChainExpression") return isOwnerDocMember(node.expression);
  if (node.type === "TSAsExpression" || node.type === "TSNonNullExpression")
    return isOwnerDocMember(node.expression);
  if (node.type !== "MemberExpression" || node.computed) return false;
  if (node.property.type !== "Identifier" || node.property.name !== "doc")
    return false;
  const object =
    node.object.type === "ChainExpression"
      ? node.object.expression
      : node.object;
  // `runsToXmlText(runs).doc` is a headless replica minted by that call — a
  // throwaway, never the owner's canonical. The one call that DOES hand back
  // an owner is the registry read, `blockDocOwnerOf(id)?.doc`.
  if (object.type !== "CallExpression") return true;
  return (
    object.callee.type === "Identifier" && object.callee.name === OWNER_LOOKUP
  );
}

/** `applyUpdate(...)` or `<ns>.applyUpdate(...)`. */
function isApplyUpdateCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name === APPLY_UPDATE;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === APPLY_UPDATE
  );
}

export default createRule({
  name: "no-adhoc-doc-write",
  meta: {
    type: "problem",
    docs: {
      description:
        "no applyUpdate onto a block owner's canonical Y.Doc outside the replay host, " +
        "the transport providers and the binding relay (a fourth origin is read as " +
        "the user typing, flushed, rendered, and undoable by nothing)",
    },
    schema: [],
    messages: {
      adhocWrite:
        "`applyUpdate({{target}}, …)` writes a block owner's canonical doc from a " +
        "module that is none of its three origins. Only `web/internal/block-text-write.ts` " +
        "(the replay host), the two transport providers and `binding-replica.ts` (the " +
        "relay) may apply onto an owner's doc. To bring a block to a given text, record " +
        "a data entry and replay it through `applyBlockRuns` " +
        "(`web/internal/block-text-write-stored.ts`), or drive the edit through the " +
        "block's Lexical editor so the binding relays it. See " +
        "research/2026-09-09-page-data-based-text-undo-entries-v2.md §2.3–2.4.",
    },
  },
  defaultOptions: [],
  create(context) {
    /** Is `id`'s declaration a local bound to an owner-shaped doc read? */
    const boundToOwnerDoc = (id: TSESTree.Identifier): boolean => {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(id),
        id.name,
      );
      const def = variable?.defs[0];
      return (
        def?.type === "Variable" &&
        def.node.init !== null &&
        isOwnerDocMember(def.node.init)
      );
    };
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isApplyUpdateCall(node)) return;
        const target = node.arguments[0];
        if (!target) return;
        const offending =
          isOwnerDocMember(target) ||
          (target.type === "Identifier" && boundToOwnerDoc(target));
        if (!offending) return;
        context.report({
          node,
          messageId: "adhocWrite",
          data: { target: context.sourceCode.getText(target) },
        });
      },
    };
  },
});
