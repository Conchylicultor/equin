import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-adhoc-row-list
 *
 * Tripwire for the DataView-avoidance footgun: mapping a collection of domain
 * records straight into `<Row>` —
 *
 *   items.map((i) => <Row key={i.id} … />)   // <-- flagged
 *
 * A homogeneous set of domain records (DB / live-state / config rows) is a
 * DataView surface — declaring a `FieldDef[]` schema and rendering
 * `<DataView views={["list"]}>` yields search / filter / sort / groupBy /
 * item-actions for free. A hand-rolled `.map` → `<Row>` reinvents that list and
 * is lint-clean and cheaper, so nothing pushes an agent toward the primitive.
 * This rule fires at authoring time and redirects to it. There is no autofix —
 * choosing the field schema, the config, and whether the list is genuinely a
 * DataView are all unsafe to mechanize.
 *
 * Detection mirrors `no-hand-rolled-entity-projection`'s philosophy: NAME-BASED,
 * with NO import/type resolution. Contributed rules run as `error`, so a false
 * positive BREAKS THE BUILD — the matcher therefore favors FALSE NEGATIVES over
 * false positives. An aliased `import { Row as R }` evades it (accepted, not a
 * gap); a fragment or wrapper element that merely CONTAINS a Row is deliberately
 * NOT flagged (keeps grouped/bespoke compositions out); `SectionHeaderRow` is
 * not a data row and is left alone.
 *
 * Fires when ALL hold (see create()):
 *   (1) The call is a `.map(cb)` (non-computed member named `map`).
 *   (2) `cb` is an arrow/function expression.
 *   (3) Some RETURNED expression of `cb` resolves — after unwrapping ternaries,
 *       `&&`, and `as` casts — to a `JSXElement` whose opening name is the bare
 *       identifier `Row`.
 */

const createRule = lintRuleCreator(import.meta.url);

/**
 * Collect the return-argument expressions of a map callback: the arrow's
 * expression body directly, or every `ReturnStatement` argument reachable in the
 * block WITHOUT descending into a nested function scope (a nested function's
 * returns belong to that function, not to the map callback — so a `<Row>`
 * returned by an inner helper must NOT count). Copied-in-spirit from the
 * enclosing-scope walks in `no-hand-rolled-entity-projection`.
 */
function collectReturnedExpressions(
  cb: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
): TSESTree.Expression[] {
  // `(i) => <Row/>` — the expression body IS the returned value.
  if (cb.body.type !== "BlockStatement") return [cb.body];

  const out: TSESTree.Expression[] = [];
  // Walk statements, gathering `return <expr>` but stopping at any nested
  // function boundary so we only see THIS callback's returns.
  const walk = (node: TSESTree.Node): void => {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return; // a nested function scope — its returns are not ours
    }
    if (node.type === "ReturnStatement" && node.argument) {
      out.push(node.argument);
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && "type" in child) {
            walk(child as TSESTree.Node);
          }
        }
      } else if (value && typeof value === "object" && "type" in value) {
        walk(value as TSESTree.Node);
      }
    }
  };
  walk(cb.body);
  return out;
}

/**
 * Resolve a returned expression to the concrete `JSXElement`s it may evaluate
 * to, unwrapping the value-selecting wrappers: a `ConditionalExpression` (both
 * branches), a `LogicalExpression` (the right operand — `cond && <Row/>`), and a
 * TS `as` cast. Anything else terminates the walk. Crucially, we do NOT descend
 * into a JSXElement's children — a wrapper/fragment that CONTAINS a Row resolves
 * to the wrapper, not the Row, so it is a deliberate false negative.
 */
function resolveJsxElements(
  expr: TSESTree.Node,
  out: TSESTree.JSXElement[],
): void {
  if (expr.type === "JSXElement") {
    out.push(expr);
  } else if (expr.type === "ConditionalExpression") {
    resolveJsxElements(expr.consequent, out);
    resolveJsxElements(expr.alternate, out);
  } else if (expr.type === "LogicalExpression") {
    resolveJsxElements(expr.right, out);
  } else if (
    expr.type === "TSAsExpression" ||
    expr.type === "TSNonNullExpression"
  ) {
    resolveJsxElements(expr.expression, out);
  }
  // Anything else terminates the walk (deliberate false negative).
}

/** Is `el`'s opening tag the bare identifier `Row` (not `SectionHeaderRow`, not `Foo.Row`)? */
function isBareRowElement(el: TSESTree.JSXElement): boolean {
  const name = el.openingElement.name;
  return name.type === "JSXIdentifier" && name.name === "Row";
}

export default createRule({
  name: "no-adhoc-row-list",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow mapping a collection of domain records into <Row> — a homogeneous " +
        "set of domain records is a DataView surface (declare a FieldDef[] schema and " +
        "render <DataView views={[\"list\"]}>), not a hand-rolled Row stack.",
    },
    schema: [],
    messages: {
      adhocRowList:
        "Mapping data into `<Row>` hand-rolls a data list. A collection of homogeneous " +
        "domain records is a DataView surface — declare a `FieldDef[]` schema and render " +
        "`<DataView views={[\"list\"]}>` (search/filter/sort/groupBy/item-actions come free; " +
        "see plugins/primitives/plugins/data-view/CLAUDE.md). If this is genuinely transient " +
        "chrome (a menu, picker, tab strip, or typeahead), keep `Row` and add " +
        "`// eslint-disable-next-line data-view/no-adhoc-row-list -- <reason>`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        // (1) `.map(cb)` — cheapest filter first; discards nearly every call.
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.computed ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "map"
        ) {
          return;
        }

        // (2) The first argument must be a callback (arrow/function expression).
        const cb = node.arguments[0];
        if (
          !cb ||
          (cb.type !== "ArrowFunctionExpression" &&
            cb.type !== "FunctionExpression")
        ) {
          return;
        }

        // (3) Some returned expression resolves to a bare `<Row>` — report ONCE
        // per `.map` call, anchored on the `map` property itself. The map line is
        // where the "hand-rolled list" decision lives, so a
        // `// eslint-disable-next-line … -- <reason>` sits naturally above it
        // (reporting the Row element would strand the disable when the JSX is
        // several lines below the map).
        const hasRow = collectReturnedExpressions(cb).some((returned) => {
          const elements: TSESTree.JSXElement[] = [];
          resolveJsxElements(returned, elements);
          return elements.some(isBareRowElement);
        });
        if (hasRow) {
          context.report({
            node: node.callee.property,
            messageId: "adhocRowList",
          });
        }
      },
    };
  },
});
