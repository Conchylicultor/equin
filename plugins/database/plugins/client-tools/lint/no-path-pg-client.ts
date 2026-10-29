import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-path-pg-client
 *
 * The Postgres client tools are vendored (plugins/database/plugins/client-tools),
 * built from the same release as the embedded server. Spawning one by bare
 * name looks it up on the PATH instead: that silently needs a system Postgres
 * install (it is what made Homebrew a prerequisite), and gets whatever version
 * that install is — an 18.6 client once ran against the 18.3 cluster.
 *
 * Flags a string literal `pg_dump` / `pg_restore` / `pg_dumpall` as the FIRST
 * element of an array literal passed straight to a function call — the argv
 * shape every spawn helper takes (`spawnCaptured(["pg_dump", …])`,
 * `Bun.spawn([…])`, `backgroundArgv([…])`). The fix is `pgClientBin("pg_dump")`.
 *
 * Only a call argument: a list of tool NAMES (`const TOOLS = ["pg_dump", …]`,
 * `new Set([…])`) runs nothing and is not a PATH lookup.
 */

const PATH_LOOKED_UP = new Set(["pg_dump", "pg_restore", "pg_dumpall"]);

export default createRule({
  name: "no-path-pg-client",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow spawning pg_dump / pg_restore by bare name — use pgClientBin() so the vendored, server-matched build runs.",
    },
    schema: [],
    messages: {
      pathLookup:
        "`{{name}}` here is looked up on the PATH, which needs a system Postgres " +
        'install and runs whatever version it has. Use pgClientBin("{{name}}") ' +
        "from @plugins/database/plugins/client-tools/server — the vendored build " +
        "from the same Postgres release as the embedded server.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ArrayExpression(node) {
        const parent = node.parent;
        if (
          parent?.type !== "CallExpression" ||
          !parent.arguments.includes(node)
        ) {
          return;
        }
        const first = node.elements[0];
        if (
          first?.type === "Literal" &&
          typeof first.value === "string" &&
          PATH_LOOKED_UP.has(first.value)
        ) {
          context.report({
            node: first,
            messageId: "pathLookup",
            data: { name: first.value },
          });
        }
      },
    };
  },
});
