import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-clock-in-served
 *
 * A served live read is a pure function of its params and the rows it reads:
 * the server recomputes it when a write lands, never when the clock moves. A
 * loader that reads the clock — `Date.now()`, `new Date()`, a `sql` template
 * with `now()` / `current_date` — answers right once and then goes stale at
 * midnight (or the turn of the month) until some unrelated write recomputes
 * it. What varies with time is declared and pinned by the READER: a clock
 * param on a value (`clockParam.day()`, `clockParam.month({ zone })`, filled
 * by `useClockParam`), a clock field on a collection (`clockField`). Compiled
 * SQL is held to the same rule at module eval (query-resource's
 * `assertStableRead`); this rule covers the hand-written loaders.
 *
 * Flags, anywhere inside the arguments of a `serveValue` / `serveCollection` /
 * `serveUnionCollection` / `serveValueOn` / `serveCollectionOn` call: a
 * `Date.now()` call, a `new Date()` with no argument, and a `sql` tagged
 * template whose text reads the clock. A function the loader calls by name is
 * not traced — keep the clock out of what a loader reaches, and pass a pinned
 * param in.
 */

const SERVES = new Set([
  "serveValue",
  "serveCollection",
  "serveUnionCollection",
  "serveValueOn",
  "serveCollectionOn",
]);

/** The SQL-text clock reads `assertStableRead` refuses in compiled SQL. */
const SQL_CLOCK =
  /\b(now\s*\(|clock_timestamp\s*\(|statement_timestamp\s*\(|transaction_timestamp\s*\(|timeofday\s*\(|current_date\b|current_time\b|current_timestamp\b|localtime\b|localtimestamp\b)/i;

function calleeName(node: TSESTree.CallExpression): string | null {
  if (node.callee.type === "Identifier") return node.callee.name;
  if (
    node.callee.type === "MemberExpression" &&
    node.callee.property.type === "Identifier"
  ) {
    return node.callee.property.name;
  }
  return null;
}

function isServeArgument(node: TSESTree.Node): boolean {
  for (let at: TSESTree.Node | undefined = node; at; at = at.parent) {
    const parent: TSESTree.Node | undefined = at.parent;
    if (
      parent?.type === "CallExpression" &&
      parent.arguments.includes(at as TSESTree.CallExpressionArgument)
    ) {
      const name = calleeName(parent);
      if (name !== null && SERVES.has(name)) return true;
    }
  }
  return false;
}

export default createRule({
  name: "no-clock-in-served",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading the clock (Date.now(), new Date(), now() / current_date in sql) inside a served live read — declare a clock param or a clock field, pinned by the reader.",
    },
    schema: [],
    messages: {
      clock:
        "{{what}} inside a served live read: the server recomputes on a write, " +
        "never when the clock moves, so this answer goes stale at the next " +
        "midnight / month until some unrelated write. Declare what varies with " +
        "time and let the reader pin it — a clock param on the value " +
        "(`params: { today: clockParam.day() }`, filled by `useClockParam`) or " +
        "a clock field on the collection (`clockField.elapsed`). See " +
        "plugins/network/plugins/live/CLAUDE.md, *Clock reads*.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "Date" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "now" &&
          isServeArgument(node)
        ) {
          context.report({
            node,
            messageId: "clock",
            data: { what: "`Date.now()`" },
          });
        }
      },
      NewExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Date" &&
          node.arguments.length === 0 &&
          isServeArgument(node)
        ) {
          context.report({
            node,
            messageId: "clock",
            data: { what: "`new Date()`" },
          });
        }
      },
      TaggedTemplateExpression(node) {
        const tag = node.tag;
        const isSql =
          (tag.type === "Identifier" && tag.name === "sql") ||
          (tag.type === "MemberExpression" &&
            tag.property.type === "Identifier" &&
            tag.object.type === "Identifier" &&
            tag.object.name === "sql");
        if (!isSql) return;
        const hit = node.quasi.quasis
          .map((q) => SQL_CLOCK.exec(q.value.cooked ?? q.value.raw))
          .find((m) => m !== null);
        if (hit && isServeArgument(node)) {
          context.report({
            node,
            messageId: "clock",
            data: { what: `\`${hit[1]!.replace(/\s*\($/, "()")}\` in sql` },
          });
        }
      },
    };
  },
});
