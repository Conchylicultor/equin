/**
 * Bans hand-rolling a resource result outside the plugins that own the shape
 * (derived from `./result-constructors.ts`: every plugin a sanctioned
 * constructor is exported from).
 *
 * A domain hook that re-shapes a read by writing its own
 * `{ status: "loading" }` / `{ status: "error", … }` arms drops whatever it does
 * not copy — the typed error, `stale`, `refetch` — and forks the vocabulary a
 * surface renders from. The one way to derive a read is `mapResource` (one read)
 * or `combineResources` (several), which pass every arm through untouched; a
 * plain value comes out through `foldResource`. The full set of sanctioned
 * constructors — and so the owners, and this rule's message — is the table in
 * `./result-constructors.ts`.
 *
 * What counts as a hand-rolled result (all syntactic):
 *   - an object literal or type literal whose `status` is `"loading"` or
 *     `"error"` and which also carries a result member — `refetch`, `stale` or
 *     `pending`;
 *   - an object literal whose `status` is `"ready"` next to `data` and a result
 *     member (`refetch` / `pending`) — the hand-rolled ready arm;
 *   - a union type spelling the result vocabulary — a `status: "ready"` arm
 *     beside a `status: "loading"` or `status: "error"` one.
 *
 * Domain state machines that merely share a word (`{ status: "loading" }` next to
 * `"found"` / `"missing"`) are not results and are not matched. Test code is
 * exempt — a fixture standing in for a read has to spell one.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { isTestFile } from "./result-binding";
import {
  RESULT_CONSTRUCTORS,
  RESULT_OWNERS,
  resultConstructorsMessage,
} from "./result-constructors";

const createRule = lintRuleCreator(import.meta.url);

const RESULT_MEMBERS = new Set(["refetch", "stale", "pending"]);

function keyName(
  key: TSESTree.Expression | TSESTree.PrivateIdentifier,
): string | null {
  if (key.type === AST_NODE_TYPES.Identifier) return key.name;
  if (key.type === AST_NODE_TYPES.Literal && typeof key.value === "string") {
    return key.value;
  }
  return null;
}

/** An object literal's `status` string value and its other key names. */
function objectShape(node: TSESTree.ObjectExpression): {
  status: string | null;
  keys: Set<string>;
} {
  let status: string | null = null;
  const keys = new Set<string>();
  for (const p of node.properties) {
    if (p.type !== AST_NODE_TYPES.Property || p.computed) continue;
    const name = keyName(p.key);
    if (name === null) continue;
    keys.add(name);
    if (
      name === "status" &&
      p.value.type === AST_NODE_TYPES.Literal &&
      typeof p.value.value === "string"
    ) {
      status = p.value.value;
    }
  }
  return { status, keys };
}

/** A type literal's `status` string-literal type and its member names. */
function typeShape(node: TSESTree.TSTypeLiteral): {
  status: string | null;
  keys: Set<string>;
} {
  let status: string | null = null;
  const keys = new Set<string>();
  for (const m of node.members) {
    if (m.type !== AST_NODE_TYPES.TSPropertySignature || m.computed) continue;
    const name = keyName(m.key);
    if (name === null) continue;
    keys.add(name);
    const t = m.typeAnnotation?.typeAnnotation;
    if (
      name === "status" &&
      t?.type === AST_NODE_TYPES.TSLiteralType &&
      t.literal.type === AST_NODE_TYPES.Literal &&
      typeof t.literal.value === "string"
    ) {
      status = t.literal.value;
    }
  }
  return { status, keys };
}

function hasResultMember(keys: Set<string>): boolean {
  for (const k of keys) if (RESULT_MEMBERS.has(k)) return true;
  return false;
}

function isResultArm(shape: {
  status: string | null;
  keys: Set<string>;
}): boolean {
  if (shape.status === "loading" || shape.status === "error") {
    return hasResultMember(shape.keys);
  }
  if (shape.status === "ready") {
    return (
      shape.keys.has("data") &&
      (shape.keys.has("refetch") || shape.keys.has("pending"))
    );
  }
  return false;
}

export default createRule({
  name: "no-handrolled-result",
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow hand-rolled `status: "loading" | "error" | "ready"` resource results outside the plugins that own the shape — obtain or derive one through a sanctioned constructor: ' +
        RESULT_CONSTRUCTORS.map((c) => c.name).join(", ") +
        ".",
    },
    schema: [],
    messages: {
      handrolled:
        "Hand-rolled resource result. Re-shaping a read by writing its own `status` arms drops what it does not copy (the typed error, `stale`, `refetch`). " +
        "Obtain or derive it through a sanctioned constructor instead, and type it `ResourceResult<U>`: " +
        resultConstructorsMessage() +
        ". See plugins/primitives/plugins/live-state/CLAUDE.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;
    if (isTestFile(filename)) return {};
    if (RESULT_OWNERS.some((o) => filename.includes(o))) return {};
    return {
      ObjectExpression(node) {
        if (isResultArm(objectShape(node))) {
          context.report({ node, messageId: "handrolled" });
        }
      },
      TSTypeLiteral(node) {
        // A union is judged whole (below); only a lone literal is judged here.
        if (node.parent.type === AST_NODE_TYPES.TSUnionType) return;
        if (isResultArm(typeShape(node))) {
          context.report({ node, messageId: "handrolled" });
        }
      },
      TSUnionType(node) {
        const statuses = new Set<string>();
        let arm = false;
        for (const t of node.types) {
          if (t.type !== AST_NODE_TYPES.TSTypeLiteral) continue;
          const shape = typeShape(t);
          if (shape.status !== null) statuses.add(shape.status);
          if (isResultArm(shape)) arm = true;
        }
        const vocabulary =
          statuses.has("ready") &&
          (statuses.has("loading") || statuses.has("error"));
        if (arm || vocabulary) {
          context.report({ node, messageId: "handrolled" });
        }
      },
    };
  },
});
