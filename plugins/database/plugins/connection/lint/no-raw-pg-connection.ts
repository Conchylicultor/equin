import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-raw-pg-connection
 *
 * Every backend database connection must be built by the connection plugin
 * (`createDbPool` / `createDbClient`), because that is where the deadline
 * lives: a pg.Client subclass that gives up on a connect or a query that gets
 * no reply, abandons the connection, and reports it. A connection built any
 * other way can wait forever in silence — on 2026-09-15 a job waited 2.5 hours
 * on one. See research/2026-09-16-global-db-call-deadline-every-connection.md.
 *
 * Flags:
 *   - `new Pool(…)` / `new Client(…)` where the class comes from "pg" — a named
 *     import (aliases included), or a default / namespace import used as
 *     `new pg.Pool(…)`;
 *   - a `connectionString` property in an object literal passed to
 *     graphile-worker's `run` / `runOnce` / `makeWorkerUtils` / `runMigrations`
 *     (named import, aliases included, or a namespace import), which makes
 *     graphile-worker build its own raw pool. Pass `pgPool` instead.
 *
 * Not flagged (the rule is for code that runs inside a backend, where a lost
 * call has a report to land in):
 *   - the connection plugin itself — it IS the sanctioned construction site
 *     (`connection/exempt/index.ts`);
 *   - any file under a `cli/`, `scripts/` or `e2e/` directory, and tests (the
 *     barrel's `outOfScope`), or a `check/` or `lint/` directory (skipped here).
 *
 * A backend site that genuinely cannot use the plugin (a process with no report
 * path, a test stand-in) takes an `eslint-disable-next-line` with its reason.
 */

// FileCategory has no `check` / `lint` (leaf folders, not categories), so this
// rule still skips them itself; `cli`, `script`, `e2e` and tests are rule scope
// in the lint barrel.
const EXEMPT_SEGMENTS = ["/check/", "/lint/"];

const PG_CLASSES = new Set(["Pool", "Client"]);
const GRAPHILE_ENTRYPOINTS = new Set([
  "run",
  "runOnce",
  "makeWorkerUtils",
  "runMigrations",
]);

function isExemptPath(rawFilename: string): boolean {
  const filename = `/${rawFilename.split("\\").join("/")}`;
  return EXEMPT_SEGMENTS.some((seg) => filename.includes(seg));
}

function propertyName(node: TSESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  return null;
}

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed) return propertyName(node.property);
  return node.property.type === "Literal" ? propertyName(node.property) : null;
}

export default createRule({
  name: "no-raw-pg-connection",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow building a raw pg connection in backend code — use createDbPool / createDbClient so every call has a deadline.",
    },
    schema: [],
    messages: {
      rawPgConnection:
        "Build this connection with createDbPool / createDbClient from " +
        "@plugins/database/plugins/connection/server, not `new {{name}}` from " +
        '"pg". A raw connection has no deadline: a connect or query that gets ' +
        "no reply waits forever in silence (a job once waited 2.5 hours). The " +
        "plugin's connections fail that call, abandon the connection and report " +
        "it. See research/2026-09-16-global-db-call-deadline-every-connection.md.",
      graphileConnectionString:
        "Don't pass `connectionString` to graphile-worker's `{{name}}`: it " +
        "builds its own raw pg pool with no deadline, so a call that gets no " +
        "reply waits forever in silence. Build the pool with createDbPool from " +
        "@plugins/database/plugins/connection/server and pass it as `pgPool`, " +
        "so a silent call fails and is reported.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (isExemptPath(context.filename ?? "")) return {};

    /** Local name → "Pool" | "Client", for named imports from "pg". */
    const pgClassLocals = new Map<string, string>();
    /** Default / namespace imports of "pg" (`pg` in `new pg.Pool`). */
    const pgNamespaces = new Set<string>();
    /** Local name → graphile-worker entrypoint name. */
    const graphileLocals = new Map<string, string>();
    /** Default / namespace imports of "graphile-worker". */
    const graphileNamespaces = new Set<string>();

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const source = node.source.value;
        if (source !== "pg" && source !== "graphile-worker") return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            if (spec.importKind === "type") continue;
            const imported = propertyName(spec.imported);
            if (imported === null) continue;
            if (source === "pg" && PG_CLASSES.has(imported)) {
              pgClassLocals.set(spec.local.name, imported);
            } else if (
              source === "graphile-worker" &&
              GRAPHILE_ENTRYPOINTS.has(imported)
            ) {
              graphileLocals.set(spec.local.name, imported);
            }
          } else {
            (source === "pg" ? pgNamespaces : graphileNamespaces).add(
              spec.local.name,
            );
          }
        }
      },

      NewExpression(node) {
        const callee = node.callee;
        let name: string | undefined;
        if (callee.type === "Identifier") {
          name = pgClassLocals.get(callee.name);
        } else if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          pgNamespaces.has(callee.object.name)
        ) {
          const member = memberName(callee);
          if (member !== null && PG_CLASSES.has(member)) name = member;
        }
        if (name !== undefined) {
          context.report({
            node,
            messageId: "rawPgConnection",
            data: { name },
          });
        }
      },

      CallExpression(node) {
        const callee = node.callee;
        let name: string | undefined;
        if (callee.type === "Identifier") {
          name = graphileLocals.get(callee.name);
        } else if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          graphileNamespaces.has(callee.object.name)
        ) {
          const member = memberName(callee);
          if (member !== null && GRAPHILE_ENTRYPOINTS.has(member))
            name = member;
        }
        if (name === undefined) return;
        for (const arg of node.arguments) {
          if (arg.type !== "ObjectExpression") continue;
          for (const prop of arg.properties) {
            if (
              prop.type === "Property" &&
              !prop.computed &&
              propertyName(prop.key) === "connectionString"
            ) {
              context.report({
                node: prop,
                messageId: "graphileConnectionString",
                data: { name },
              });
            }
          }
        }
      },
    };
  },
});
