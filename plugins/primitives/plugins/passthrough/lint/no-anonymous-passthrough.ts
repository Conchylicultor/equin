import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * An index signature written inline in a props type — `[key: string]: unknown`
 * inside `interface FooProps { … }` — opens a passthrough and says nothing
 * about where it lands.
 *
 * That is the whole bug this plugin exists for. `Row` shipped exactly this
 * signature, documented as "spread onto the rendered element", and rendered one
 * element right up until it was given `actions` — from which point a caller's
 * `data-*` selector target sat on an inner `<button>` instead of the row box.
 * No throw, no type error, and the call site that broke was not the call site
 * that changed. Spelling the passthrough as
 * `extends Passthrough` (`@plugins/primitives/plugins/passthrough/core`) states
 * the destination: `ref` NAMES the node, the bag ADDRESSES it, and they are
 * declared together so a props type cannot be open without exposing the node.
 *
 * This rule is the GATE, not the guarantee. The guarantee is
 * `passthrough/no-unanchored-passthrough`, which watches the rest binding
 * inside the component — and it finds its subjects through the type checker, by
 * asking whether the props type has a string index signature. A hand-written
 * index signature is perfectly visible to it. What is NOT visible is the
 * intent: without the marker there is no `ref` on the type, so the "which node?"
 * question has no answer to check against, and every new primitive re-decides in
 * private whether it has one. Requiring the marker makes the pair inseparable at
 * the declaration site, which is the only place it can be made inseparable.
 *
 * ## Why it keys on the NAME
 *
 * `[key: string]: unknown` is not by itself a React idiom. Nine types in this
 * repo carry it for unrelated, legitimate reasons — the durable event payloads
 * (`ConversationTurnCompletedPayload`, `RefAdvancedPayload`,
 * `TaskStatusChangedPayload`, the page/workflow/task table event rows) and the
 * plugin contribution records (`Contribution`, `ServerContribution`). Those are
 * open BAGS OF DATA, not props: nothing spreads them onto an element, there is
 * no node for a `ref` to name, and `extends Passthrough` would be a lie about
 * them. So the rule fires only on a declaration whose name ends in `Props`,
 * which is the repo-wide convention for exactly one thing.
 *
 * The `Passthrough` marker itself is exempt by the same construction — its name
 * is not `*Props` — so no path allowlist is needed to keep the definition site
 * from tripping its own rule.
 *
 * ## What it does NOT look at
 *
 * Only the DIRECT body of the `*Props` declaration. An index signature nested
 * inside a property (`interface FooProps { meta: { [k: string]: unknown } }`) is
 * a dictionary-shaped field, not the props passthrough, and is left alone.
 *
 * The value type must be `unknown` or `any` — the two spellings of "anything at
 * all". A narrower one (`[key: string]: string`) describes a dictionary the
 * component reads, not a bag it spreads.
 *
 * Accepted false negative: a props type that opens itself by extending some
 * OTHER open type of its own. The checker-driven second rule still sees such a
 * component, so the promise is still enforced on it; what is lost is the
 * declaration-site nudge.
 *
 * No auto-fix: the replacement needs an import added, and choosing between
 * `Passthrough` and `Passthrough<HTMLDivElement>` is a per-primitive judgement
 * (a mutable ref is invariant, so a primitive whose `ref` is narrower than
 * `HTMLElement` must say so).
 */

/** The two spellings of "any value at all" — both are an open bag. */
const OPEN_VALUE_TYPES = new Set<string>(["TSUnknownKeyword", "TSAnyKeyword"]);

/**
 * The name of the declaration this index signature is a DIRECT member of, or
 * undefined when it is nested inside a property, an inline parameter type, or
 * anything else that is not a named `interface` / `type` declaration.
 */
function declarationName(node: TSESTree.TSIndexSignature): string | undefined {
  const body = node.parent;
  // `interface FooProps { [key: string]: unknown }`
  if (body.type === "TSInterfaceBody") {
    const decl = body.parent;
    return decl.type === "TSInterfaceDeclaration" ? decl.id.name : undefined;
  }
  // `type FooProps = { [key: string]: unknown }`
  if (body.type === "TSTypeLiteral") {
    const decl = body.parent;
    return decl.type === "TSTypeAliasDeclaration" ? decl.id.name : undefined;
  }
  return undefined;
}

/** `[key: string]: unknown` — a string-keyed signature holding an open value. */
function isOpenStringIndex(node: TSESTree.TSIndexSignature): boolean {
  const [param] = node.parameters;
  if (!param || param.type !== "Identifier") return false;
  const key = param.typeAnnotation?.typeAnnotation;
  if (!key || key.type !== "TSStringKeyword") return false;
  const value = node.typeAnnotation?.typeAnnotation;
  if (!value) return false;
  return OPEN_VALUE_TYPES.has(value.type);
}

export default createRule({
  name: "no-anonymous-passthrough",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow an inline `[key: string]: unknown` index signature in a *Props type — an anonymous passthrough states no destination and exposes no node, so nothing can check that the bag and the caller's `ref` stay on the same element. Spell it `extends Passthrough`.",
    },
    schema: [],
    messages: {
      anonymousPassthrough:
        "`{{name}}` opens a passthrough anonymously. An open props bag is a promise that everything " +
        "spread lands on ONE node — and `ref` is that node's name — so declare the two together: " +
        "`interface {{name}} extends Passthrough` (import `Passthrough` from " +
        "`@plugins/primitives/plugins/passthrough/core`), then delete this index signature. Use " +
        "`Passthrough<HTMLDivElement>` when the primitive's `ref` is narrower than `HTMLElement`. " +
        "Last resort: // eslint-disable-next-line passthrough/no-anonymous-passthrough -- <reason>.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      TSIndexSignature(node: TSESTree.TSIndexSignature) {
        if (!isOpenStringIndex(node)) return;
        const name = declarationName(node);
        if (!name || !name.endsWith("Props")) return;
        context.report({
          node,
          messageId: "anonymousPassthrough",
          data: { name },
        });
      },
    };
  },
});
