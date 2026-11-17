/**
 * no-blob-in-state
 *
 * A Blob, a File or a MediaStream never sits in React state (`useState`,
 * `useReducer`) or in a ref (`useRef`). Component state is lost on a reload
 * and on a tab switch (tab residency unmounts hidden tabs), and a blob cannot
 * be kept in browser storage (≈10 MB per origin) — so a captured screenshot, a
 * recording or a picked file held there is work that is lost for good.
 *
 * Upload it as soon as it exists, as a staged attachment (`infra/attachments`
 * `uploadAttachment`), and keep the attachment id as kept work (`useKept`); read
 * the bytes back with `useLive(attachmentBytes, { id })`. A blob DERIVED from
 * kept data (an image with its kept edits applied) is a memoized value, not
 * state. Design: research/2026-11-17-global-lossless-reload.md ("Blobs").
 *
 * Type-aware: the held type is read from the hook call (`useState`'s state,
 * `useReducer`'s state, `useRef`'s `current`), so `useState(file)` is caught
 * without an annotation. A union or an array containing one counts.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

const createRule = lintRuleCreator(import.meta.url);

const BANNED = new Set(["Blob", "File", "MediaStream"]);
const HOOKS = new Set(["useState", "useReducer", "useRef"]);

function hookName(callee: TSESTree.Expression): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  )
    return callee.property.name;
  return null;
}

export default createRule({
  name: "no-blob-in-state",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow holding a Blob / File / MediaStream in useState, useReducer or useRef: it is lost on reload and cannot be kept. Upload it as a staged attachment and keep its id.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      blobInState:
        "This {{hook}} holds a {{type}}: it is lost on a reload and on a tab switch, and a blob cannot be kept in browser storage. " +
        "Upload it as a staged attachment (`uploadAttachment`) and keep the attachment id with `useKept`; a blob derived from kept data is a memoized value, not state.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    /** The banned type `type` is or contains (union member, array element), else null. */
    const bannedIn = (type: ts.Type, depth = 0): string | null => {
      if (depth > 3) return null;
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
      if (type.isUnion()) {
        for (const part of type.types) {
          const hit = bannedIn(part, depth + 1);
          if (hit) return hit;
        }
        return null;
      }
      const name = type.getSymbol()?.getName();
      if (name !== undefined && BANNED.has(name)) return name;
      // `File extends Blob` and any other subclass.
      for (const base of type.getBaseTypes?.() ?? []) {
        const hit = bannedIn(base, depth + 1);
        if (hit) return hit;
      }
      if (checker.isArrayType(type)) {
        const [element] = checker.getTypeArguments(type as ts.TypeReference);
        if (element) return bannedIn(element, depth + 1);
      }
      return null;
    };

    /** The held value's type: the state (first tuple member) or the ref's `current`. */
    const heldType = (
      call: ts.CallExpression,
      hook: string,
    ): ts.Type | null => {
      const result = checker.getTypeAtLocation(call);
      if (hook === "useRef") {
        const current = result.getProperty("current");
        return current
          ? checker.getTypeOfSymbolAtLocation(current, call)
          : null;
      }
      const state = result.getProperty("0");
      return state ? checker.getTypeOfSymbolAtLocation(state, call) : null;
    };

    return {
      CallExpression(node: TSESTree.CallExpression) {
        const hook = hookName(node.callee);
        if (hook === null || !HOOKS.has(hook)) return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const held = heldType(tsNode, hook);
        if (held === null) return;
        const type = bannedIn(held);
        if (type !== null)
          context.report({
            node,
            messageId: "blobInState",
            data: { hook, type },
          });
      },
    };
  },
});
