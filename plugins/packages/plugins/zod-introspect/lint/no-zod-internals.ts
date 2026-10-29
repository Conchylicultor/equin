/**
 * Bans reading a zod schema's internals anywhere but `packages/zod-introspect`
 * (which exempts its own reader files in its `exempt/index.ts`):
 *
 * - a `_def` or `_zod` property (read, computed read, or destructured) — zod
 *   3's def bag and zod 4's internals object. A def's `typeName` is only ever
 *   reached through one of them, so this covers `_def.typeName` too;
 * - `instanceof` a zod class (`ZodString`, `z.ZodNullable`, …) — `ZodError`
 *   excepted, it is the public parse-failure type. Class identity is
 *   version-specific (zod 4 has no `ZodEffects`, `.transform` returns a pipe);
 * - a zod 3 kind name as a string (`"ZodArray"`, the `ZodFirstPartyTypeKind`
 *   values) or the `ZodFirstPartyTypeKind` enum itself.
 *
 * Every one of those changes shape across a zod major, silently: the code
 * still type-checks and reads `undefined`. The repo-owned `SchemaNode`
 * (`@plugins/packages/plugins/zod-introspect/core`: `inspect`, `peel`,
 * `childrenOf`, `defineSchemaTag`, …) is the one way to look inside a schema,
 * so the next zod major is a change to one plugin
 * (`research/2026-10-28-global-zod-4-migration.md`, Phase 2g). Self-contained
 * by necessity — the ESLint config loads rule files through jiti, which cannot
 * resolve `@plugins/*`.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const INTERNAL_KEYS: ReadonlySet<string> = new Set(["_def", "_zod"]);

/** zod 3's `ZodFirstPartyTypeKind` values — the `_def.typeName` strings. */
const ZOD3_KINDS: ReadonlySet<string> = new Set([
  "ZodString",
  "ZodNumber",
  "ZodNaN",
  "ZodBigInt",
  "ZodBoolean",
  "ZodDate",
  "ZodSymbol",
  "ZodUndefined",
  "ZodNull",
  "ZodAny",
  "ZodUnknown",
  "ZodNever",
  "ZodVoid",
  "ZodArray",
  "ZodObject",
  "ZodUnion",
  "ZodDiscriminatedUnion",
  "ZodIntersection",
  "ZodTuple",
  "ZodRecord",
  "ZodMap",
  "ZodSet",
  "ZodFunction",
  "ZodLazy",
  "ZodLiteral",
  "ZodEnum",
  "ZodEffects",
  "ZodNativeEnum",
  "ZodOptional",
  "ZodNullable",
  "ZodDefault",
  "ZodCatch",
  "ZodPromise",
  "ZodBranded",
  "ZodPipeline",
  "ZodReadonly",
]);

/** A zod class name `instanceof` may not test against. */
export function isZodClassName(name: string): boolean {
  return /^Zod[A-Z]\w*$/.test(name) && name !== "ZodError";
}

function keyName(key: TSESTree.Node, computed: boolean): string | undefined {
  if (!computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

export default createRule({
  name: "no-zod-internals",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading zod internals (`_def`, `_zod`, `instanceof Zod*`, zod kind-name strings) outside packages/zod-introspect.",
    },
    schema: [],
    messages: {
      internalKey:
        "`{{key}}` is a zod internal: its shape changes across a zod major, and the read silently becomes `undefined`. " +
        "Read the schema through `@plugins/packages/plugins/zod-introspect/core` (`inspect(schema)` → `SchemaNode`, `peel`, `childrenOf`; `defineSchemaTag` for a tag).",
      zodInstanceof:
        "`instanceof {{name}}` tests a zod class, whose identity is version-specific (zod 4 has no `ZodEffects`; `.transform` returns a pipe). " +
        'Ask `inspect(schema).kind === "…"` (`@plugins/packages/plugins/zod-introspect/core`). `instanceof ZodError` is fine.',
      zodKind:
        "`{{name}}` names a zod 3 schema kind (`_def.typeName`), which zod 4 does not have. " +
        "Compare `inspect(schema).kind` (`@plugins/packages/plugins/zod-introspect/core`) instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    const checkKey = (
      key: TSESTree.Node,
      computed: boolean,
      at: TSESTree.Node,
    ): void => {
      const name = keyName(key, computed);
      if (name !== undefined && INTERNAL_KEYS.has(name)) {
        context.report({
          node: at,
          messageId: "internalKey",
          data: { key: name },
        });
      }
    };
    const checkKind = (value: string, node: TSESTree.Node): void => {
      if (ZOD3_KINDS.has(value)) {
        context.report({ node, messageId: "zodKind", data: { name: value } });
      }
    };
    return {
      MemberExpression: (node) =>
        checkKey(node.property, node.computed, node.property),
      Property: (node) => {
        if (node.parent.type === "ObjectPattern") {
          checkKey(node.key, node.computed, node.key);
        }
      },
      BinaryExpression: (node) => {
        if (node.operator !== "instanceof") return;
        const right = node.right;
        const name =
          right.type === "Identifier"
            ? right.name
            : right.type === "MemberExpression" &&
                !right.computed &&
                right.property.type === "Identifier"
              ? right.property.name
              : undefined;
        if (name !== undefined && isZodClassName(name)) {
          context.report({
            node: right,
            messageId: "zodInstanceof",
            data: { name },
          });
        }
      },
      Literal: (node) => {
        if (typeof node.value === "string") checkKind(node.value, node);
      },
      TemplateLiteral: (node) => {
        if (node.expressions.length === 0 && node.quasis[0]) {
          checkKind(node.quasis[0].value.cooked ?? "", node);
        }
      },
      Identifier: (node) => {
        if (node.name === "ZodFirstPartyTypeKind") {
          context.report({
            node,
            messageId: "zodKind",
            data: { name: node.name },
          });
        }
      },
    };
  },
});
