import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Identifier names that Bun's TS transform silently miscompiles in value
 * position. `declare` is a TS contextual keyword: a statement that begins with
 * `declare` (e.g. `declare.foo = …` referencing a `const declare = …`) is parsed
 * by Bun as a TS *ambient declaration* and ERASED from the emitted JS — no type
 * error, no runtime error, the value is just `undefined` at runtime. tsc keeps
 * it (verified against ts.transpileModule), so this is a Bun divergence, not
 * expected TS behavior. Empirically `declare` is the only contextual keyword
 * with this hazard (`enum`/`let` fail loudly as reserved words; every other
 * keyword transpiles correctly). A Set so a future Bun regression on another
 * name is a one-line add.
 */
const BANNED_BINDING_NAMES = new Set(["declare"]);

export default createRule({
  name: "no-declare-identifier",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `declare` as a value binding name — Bun's TS transform parses " +
        "statements referencing it as ambient declarations and silently erases " +
        "them from the emitted JS.",
    },
    schema: [],
    messages: {
      bannedBinding:
        "`{{name}}` cannot be used as a variable/binding name. Bun's TS transform " +
        "parses a statement beginning with `{{name}}` as a TS ambient declaration " +
        "and silently erases it from the emitted JS — no type or runtime error, the " +
        "value is just `undefined` at runtime (tsc keeps it; this is a Bun " +
        "divergence). Rename this binding.",
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;

    // A single binding can surface as a variable in two scopes (a class/named
    // function expression binds its own name in its inner scope as well as the
    // enclosing one), pointing at the SAME identifier node. Dedupe by node so
    // one declaration yields exactly one report.
    const reported = new Set<TSESTree.Node>();

    function walk(scope: TSESLint.Scope.Scope): void {
      for (const variable of scope.variables) {
        if (!BANNED_BINDING_NAMES.has(variable.name)) continue;
        for (const def of variable.defs) {
          if (reported.has(def.name)) continue;
          reported.add(def.name);
          context.report({
            node: def.name,
            messageId: "bannedBinding",
            data: { name: variable.name },
          });
        }
      }
      scope.childScopes.forEach(walk);
    }

    return {
      "Program:exit"(node) {
        // One pass over the whole scope tree catches every binding kind —
        // var/let/const, function & class names, params, import bindings, catch
        // params, destructuring — since each becomes a `scope.variables` entry.
        // A reference to an *undeclared* `declare` is not a variable, so this is
        // bindings-only by construction.
        walk(sourceCode.getScope(node));
      },
    };
  },
});
