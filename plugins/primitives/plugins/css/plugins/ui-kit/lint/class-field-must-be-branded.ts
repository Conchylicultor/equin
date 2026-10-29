import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The `ClassName` brand (ui-kit's `core`) relocates a class literal out of a data
 * position — where no `no-adhoc-*` rule can read it — and into a `cn()` call,
 * where seven of them already do. The brand only works on fields that DECLARE it;
 * nothing stops the next API typing its class field `string` and reopening the
 * hole. This rule closes it: a field whose NAME says it carries classes must say
 * so in its TYPE.
 *
 * **Compound names only** — `panelClassName`, `iconClassNames`, `rowClasses`, but
 * never bare `className`. The capital `C` is the entire discriminator, and that
 * is deliberate: bare `className` is React's DOM prop, whose value is already
 * read at the JSX site by every class rule, and which appears on hundreds of
 * pass-through props — including every `icon: ComponentType<{ className?: string }>`,
 * where the string is React's to fill, not ours. Excluding it is what gives this
 * rule a zero false-positive rate.
 *
 * Purely syntactic: it reads the annotation's SHAPE and resolves no types, so it
 * needs no class-token walk — it is an ordinary rule module, not one of the
 * toolkit-taking `classRules` factories.
 */
const CLASS_FIELD_NAME = /^[a-z][A-Za-z0-9]*(?:ClassName|ClassNames|Classes)$/;

/** `null` and `undefined` may join `ClassName` in a union — they carry no classes. */
const NULLISH = new Set([
  "TSNullKeyword",
  "TSUndefinedKeyword",
  "TSVoidKeyword",
]);

/**
 * Is this annotation `ClassName`, a union of it with nothing but null/undefined,
 * or a function returning one of those? Anything else — `string`, a template
 * literal type, `string | ClassName` — is the hole this rule exists to close.
 *
 * `ClassName[]`/`Record<…, ClassName>` are deliberately NOT accepted: no field in
 * the repo needs them, and admitting the containers means deciding what a
 * partially-branded container means. Add a case here when a real one appears.
 */
function isBranded(node: TSESTree.TypeNode | undefined): boolean {
  if (!node) return false;
  // An if-chain rather than a `switch`: the switched value would be the full
  // type-node kind union, which `switch-exhaustiveness-check` asks every branch
  // of — and a `default` arm does not answer it (the rule's
  // `considerDefaultExhaustiveForUnions` is off). Three shapes carry the brand;
  // every other annotation is not it, which is the fall-through below.
  if (node.type === "TSTypeReference") {
    return (
      node.typeName.type === "Identifier" && node.typeName.name === "ClassName"
    );
  }
  if (node.type === "TSUnionType") {
    // Every non-nullish arm must be branded; `string | ClassName` is a `string`.
    return node.types.every((arm) => NULLISH.has(arm.type) || isBranded(arm));
  }
  if (node.type === "TSFunctionType") {
    // A per-row/per-datum resolver: brand what it RETURNS.
    return isBranded(node.returnType?.typeAnnotation);
  }
  // Any other type annotation — `string`, a template literal type, an array —
  // is not the brand.
  return false;
}

/** The declared name, when it is statically readable (never a computed key). */
function staticName(key: TSESTree.Node, computed: boolean): string | undefined {
  if (computed) return undefined;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

export default createRule({
  name: "class-field-must-be-branded",
  meta: {
    type: "problem",
    docs: {
      description:
        "A field whose name ends in ClassName/ClassNames/Classes must be typed `ClassName`, so its value comes out of cn() where the no-adhoc-* class rules can read it.",
    },
    schema: [],
    messages: {
      unbrandedClassField:
        '`{{name}}` carries class strings but is typed `{{annotation}}`. A class literal in a data position is invisible to every `no-adhoc-*` rule. Type it `ClassName` (`import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core"`) so its author has to write `cn("…")` — which is the call anchor those rules already read. A union with `null`/`undefined` and a function returning `ClassName` both count.',
    },
  },
  defaultOptions: [],
  create(context) {
    function check(
      node: TSESTree.Node,
      name: string | undefined,
      annotation: TSESTree.TypeNode | undefined,
    ) {
      if (!name || !CLASS_FIELD_NAME.test(name)) return;
      // No annotation at all: nothing declared, nothing to relocate. An
      // initializer-inferred `const` is a VariableDeclarator, which this rule
      // does not visit — the brand is about the SHAPE an API publishes.
      if (!annotation) return;
      if (isBranded(annotation)) return;
      context.report({
        node,
        messageId: "unbrandedClassField",
        data: {
          name,
          annotation: context.sourceCode.getText(annotation),
        },
      });
    }

    return {
      // `{ panelClassName?: string }` in an interface / type literal.
      TSPropertySignature(node: TSESTree.TSPropertySignature) {
        check(
          node,
          staticName(node.key, node.computed),
          node.typeAnnotation?.typeAnnotation,
        );
      },
      // `class X { panelClassName: string }`.
      PropertyDefinition(node: TSESTree.PropertyDefinition) {
        check(
          node,
          staticName(node.key, node.computed),
          node.typeAnnotation?.typeAnnotation,
        );
      },
      // `{ labelClassName(row: R): string }` — the method spelling of the
      // function-typed resolver, which `TSPropertySignature` never sees.
      TSMethodSignature(node: TSESTree.TSMethodSignature) {
        check(
          node,
          staticName(node.key, node.computed),
          node.returnType?.typeAnnotation,
        );
      },
      // `type rowClassName = string` — an alias is a published shape too.
      TSTypeAliasDeclaration(node: TSESTree.TSTypeAliasDeclaration) {
        check(node, node.id.name, node.typeAnnotation);
      },
    };
  },
});
