import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
// Relative, same-plugin: a lint rule file cannot use an `@plugins/*` specifier
// (jiti, which loads eslint.config.ts, does not resolve the alias). Importing the
// name rather than retyping it is what keeps the rule and the argv owner from
// drifting — the binary is spelled in exactly one file in the repo.
import { DRIZZLE_KIT_BIN } from "../core/internal/drizzle-cli";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Everything in the repo that can start a process. Bare identifiers are the
 * sanctioned chokepoint (`@plugins/infra/plugins/spawn/core`); `Bun.spawn` /
 * `Bun.spawnSync` are the raw forms `spawn-safety/no-raw-bun-spawn` still permits
 * in plugin server trees, tests, and migrations-interactive.ts. The set is
 * complete by construction of THAT rule: nothing else may spawn. Retyped rather
 * than imported because a cross-plugin import is unavailable here (see above).
 */
const SPAWN_CALLEES = new Set([
  "spawnCaptured",
  "spawnExpectOk",
  "spawnPassthrough",
]);

/** Array mutators that can append to an argv built earlier in the function. */
const ARRAY_APPENDERS = new Set(["push", "unshift"]);

/** Is this the binary's name, written as a plain string? */
function isBinaryLiteral(node: TSESTree.Node): boolean {
  if (node.type === "Literal") return node.value === DRIZZLE_KIT_BIN;
  if (node.type === "TemplateLiteral") {
    return (
      node.expressions.length === 0 &&
      node.quasis[0]?.value.cooked === DRIZZLE_KIT_BIN
    );
  }
  return false;
}

/** Does this callee execute a child process? */
function isSpawnCallee(callee: TSESTree.Node): boolean {
  if (callee.type === "Identifier") return SPAWN_CALLEES.has(callee.name);
  if (callee.type === "MemberExpression") {
    if (callee.object.type === "Identifier" && callee.object.name === "Bun") {
      const prop =
        !callee.computed && callee.property.type === "Identifier"
          ? callee.property.name
          : callee.computed &&
              callee.property.type === "Literal" &&
              typeof callee.property.value === "string"
            ? callee.property.value
            : null;
      return prop === "spawn" || prop === "spawnSync";
    }
    // `spawn.spawnCaptured(...)` / a namespace import's member.
    if (!callee.computed && callee.property.type === "Identifier") {
      return SPAWN_CALLEES.has(callee.property.name);
    }
  }
  return false;
}

/** Is `node` used as an argument of a spawn call? */
function isSpawnArgument(node: TSESTree.Node): boolean {
  const parent = node.parent;
  return (
    parent?.type === "CallExpression" &&
    parent.arguments.includes(node as TSESTree.CallExpressionArgument) &&
    isSpawnCallee(parent.callee)
  );
}

export default createRule({
  name: "no-adhoc-drizzle-cli",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow spawning the drizzle CLI with a hand-written argv — only the " +
        "`generate` subcommand is supported, and its argv has one owner.",
    },
    schema: [],
    messages: {
      adhocDrizzleCli:
        "Hand-written drizzle CLI argv. `generate` is the ONLY supported " +
        "subcommand: drizzle.config.ts sets dbCredentials to a non-resolving " +
        "`.invalid` sentinel, so every subcommand that dials (push / migrate / " +
        "studio / pull) fails by design. Build the argv with `drizzleGenerateArgv()` " +
        "from @plugins/database/plugins/migrations/core, which welds the binary name " +
        "to `generate` and takes typed flags — and spawn it with `cwd` at " +
        "MIGRATIONS_PLUGIN_DIR, which is equally load-bearing (the wrong cwd globs no " +
        "schema files and exits 0 with no migration). To GENERATE a migration by hand, " +
        "run `./equin build --migration-name <slug>`; to APPLY one, use the " +
        "runner, which runs on server boot. Naming " +
        "the binary somewhere that is NOT a spawn argv — a table of command names, a " +
        "message — is not an invocation and is not flagged.",
    },
  },
  defaultOptions: [],
  create(context) {
    /**
     * Does the array this literal sits in reach a spawn? Either it is passed
     * straight to one, or it is bound to a variable that is — the
     * `const cmd = [...]; ...; spawnCaptured(cmd, …)` shape both real invocation
     * sites used before they moved onto the owner.
     */
    function arrayReachesSpawn(array: TSESTree.ArrayExpression): boolean {
      if (isSpawnArgument(array)) return true;
      const declarator = array.parent;
      if (
        declarator?.type !== "VariableDeclarator" ||
        declarator.init !== array ||
        declarator.id.type !== "Identifier"
      ) {
        return false;
      }
      return identifierReachesSpawn(declarator.id);
    }

    /** Is any reference to this binding passed to a spawn call? */
    function identifierReachesSpawn(id: TSESTree.Identifier): boolean {
      // Walk out from the innermost scope containing the identifier: the binding
      // may be declared in an enclosing block/function scope (the `cmd.push(…)`
      // form reads a name declared above it).
      let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(id);
      while (scope) {
        const variable = scope.set.get(id.name);
        if (variable) {
          return variable.references.some((ref) =>
            isSpawnArgument(ref.identifier),
          );
        }
        scope = scope.upper;
      }
      return false;
    }

    return {
      "Literal, TemplateLiteral"(
        node: TSESTree.Literal | TSESTree.TemplateLiteral,
      ) {
        if (!isBinaryLiteral(node)) return;

        // Directly an argument of a spawn call: `Bun.spawn(bin, …)`-ish.
        if (isSpawnArgument(node)) {
          context.report({ node, messageId: "adhocDrizzleCli" });
          return;
        }

        const parent = node.parent;
        if (!parent) return;

        // An element of an argv array.
        if (
          parent.type === "ArrayExpression" &&
          parent.elements.includes(node as TSESTree.Expression) &&
          arrayReachesSpawn(parent)
        ) {
          context.report({ node, messageId: "adhocDrizzleCli" });
          return;
        }

        // Appended to an argv built earlier: `cmd.push("drizzle-kit")`.
        if (
          parent.type === "CallExpression" &&
          parent.arguments.includes(node as TSESTree.CallExpressionArgument) &&
          parent.callee.type === "MemberExpression" &&
          !parent.callee.computed &&
          parent.callee.property.type === "Identifier" &&
          ARRAY_APPENDERS.has(parent.callee.property.name) &&
          parent.callee.object.type === "Identifier" &&
          identifierReachesSpawn(parent.callee.object)
        ) {
          context.report({ node, messageId: "adhocDrizzleCli" });
        }
      },
    };
  },
});
