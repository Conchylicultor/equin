import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

export const ERROR_SUBJECT_MODULE =
  "@plugins/packages/plugins/error-subject/core";

function propName(p: TSESTree.Property): string | null {
  if (!p.computed && p.key.type === "Identifier") return p.key.name;
  if (p.key.type === "Literal" && typeof p.key.value === "string")
    return p.key.value;
  return null;
}

/** Does `node`'s subtree read a `.<member>` property (`err.name`, `e?.stack`)? */
function readsMember(node: TSESTree.Node, member: string): boolean {
  let found = false;
  const visit = (n: unknown): void => {
    if (found || n === null || typeof n !== "object") return;
    const t = n as TSESTree.Node;
    if (
      t.type === "MemberExpression" &&
      !t.computed &&
      t.property.type === "Identifier" &&
      t.property.name === member
    ) {
      found = true;
      return;
    }
    for (const [k, v] of Object.entries(t)) {
      if (k === "parent") continue;
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object" && "type" in v) visit(v);
    }
  };
  visit(node);
  return found;
}

/** Is `node` (a `stack` value) read off an error made right there (`new Error(m).stack`)? */
function synthesizedStack(node: TSESTree.Node): boolean {
  let n: TSESTree.Node = node;
  if (n.type === "LogicalExpression") n = n.left;
  if (n.type === "ChainExpression") n = n.expression;
  return (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.property.type === "Identifier" &&
    n.property.name === "stack" &&
    n.object.type === "NewExpression"
  );
}

/**
 * crash-fields-of
 *
 * A crash report's identity is its stack frames, plus the `scope` naming what
 * a shared throw site failed for. An error from shared code (the migration
 * runner, the trigger installer, Postgres' protocol parser) carries that
 * subject itself — a `SubjectError` subject, a class code on its cause — and a
 * filer copying `errorType: err.name, stack: err.stack` by hand drops it: every
 * failure of that code lands on one report row whatever its cause (2026-11:
 * every boot-time migration failure on one row). Reported: an object literal
 * with an `errorType` (or handed to `reportServerError`) whose `stack` reads
 * a `.stack` (or is a shorthand `stack`) — derive them with `...crashFieldsOf(err, scope?)` instead, then
 * override `errorType` when the caller declares an identity of its own. Crash
 * fields relayed from an earlier record (`errorType: r.errorType`) must relay
 * its `scope` too; better, they travel as one `CrashFields` value spread
 * whole.
 */
export default createRule({
  name: "crash-fields-of",
  meta: {
    type: "problem",
    docs: {
      description:
        "Crash-report fields are derived from the error with crashFieldsOf (packages/error-subject), never copied as errorType: err.name / stack: err.stack, so the error's own subject reaches the report's identity.",
    },
    schema: [],
    messages: {
      relayedWithoutScope: `Crash fields relayed from an earlier record (\`errorType: x.errorType\`) without its \`scope\` drop what the error was about, so every failure of a shared throw site lands on one report row whatever its cause. Relay \`scope\` too, or spread the whole \`CrashFields\` value.`,
      handCopied: `\`errorType\` / \`stack\` copied off an error by hand drop what the error is about (a SubjectError's subject, its cause's class code), so every failure of a shared throw site lands on one report row whatever its cause. Spread \`...crashFieldsOf(err, scope?)\` from "${ERROR_SUBJECT_MODULE}" instead (it yields errorType, stack and scope).`,
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ObjectExpression(obj) {
        let errorType: TSESTree.Property | null = null;
        let stack: TSESTree.Property | null = null;
        for (const p of obj.properties) {
          if (p.type !== "Property") continue;
          const name = propName(p);
          if (name === "errorType") errorType = p;
          else if (name === "stack") stack = p;
        }
        if (stack === null) return;
        // `reportServerError({ message, stack: err.stack })` — the server's
        // own crash channel — is a crash report with or without a type.
        const reported =
          obj.parent.type === "CallExpression" &&
          obj.parent.callee.type === "Identifier" &&
          obj.parent.callee.name === "reportServerError";
        if (errorType === null && !reported) return;
        // Derived, then one field overridden by a declared identity.
        if (
          obj.properties.some(
            (p) =>
              p.type === "SpreadElement" &&
              p.argument.type === "CallExpression" &&
              p.argument.callee.type === "Identifier" &&
              p.argument.callee.name === "crashFieldsOf",
          )
        )
          return;
        // `stack` shorthand holds a variable read off the error earlier.
        if (!stack.shorthand && !readsMember(stack.value, "stack")) return;
        // A stack made at the call site (`new Error(msg).stack`, a minimal
        // stack for a report with a declared type) has no error behind it,
        // so no subject to drop.
        if (!stack.shorthand && synthesizedStack(stack.value)) return;
        // A relay of crash fields recorded earlier (another process's, a
        // sink's report) has no error to derive from: it relays the scope too.
        if (errorType !== null && readsMember(errorType.value, "errorType")) {
          const hasScope = obj.properties.some(
            (p) => p.type === "Property" && propName(p) === "scope",
          );
          if (!hasScope)
            context.report({
              node: errorType,
              messageId: "relayedWithoutScope",
            });
          return;
        }
        context.report({ node: errorType ?? stack, messageId: "handCopied" });
      },
    };
  },
});
