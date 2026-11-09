import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-cell-live-read
 *
 * A field's cell must not read live data of its own:
 *
 *   { id: "size", cell: (r) => <FolderSize path={r.path} /> }
 *   function FolderSize({ path }) { const peek = useLive(computerDirPeek, { path }); … }
 *                                                       // <-- flagged at `cell`
 *
 * A `useLive` per cell is one subscription per row MOUNTED — a windowed list
 * mounts every row a scroll passes, and a released tuple lingers for the
 * keep-alive — so the list's subscriptions grow with its length and with how
 * far it was scrolled (the file explorer sent 314 `host-fs.peek` subs for one
 * scroll through /tmp). The read belongs to the field: `rowRead: rowRead({
 * value, params, cell })` (data-view web), which the DataView makes ONCE per
 * field over the rows on screen.
 *
 * Detection is NAME-BASED and same-file (no type or import resolution), and
 * favors false negatives: a `cell` / `token` property whose function calls
 * `useLive` itself, or renders (as JSX, anywhere in its body) a component
 * declared in THIS file whose body calls `useLive`. A component imported from
 * another file is not followed.
 */

const createRule = lintRuleCreator(import.meta.url);

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function isFunction(
  node: TSESTree.Node | null | undefined,
): node is FunctionNode {
  return (
    node != null &&
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression")
  );
}

/** Every node under `root` (its children, recursively), `parent` excluded. */
function walk(root: TSESTree.Node, visit: (node: TSESTree.Node) => void): void {
  visit(root);
  for (const key of Object.keys(root)) {
    if (key === "parent") continue;
    const value = (root as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          walk(child as TSESTree.Node, visit);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      walk(value as TSESTree.Node, visit);
    }
  }
}

function isUseLiveCall(node: TSESTree.Node): boolean {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "useLive"
  );
}

function callsUseLive(fn: FunctionNode): boolean {
  let found = false;
  walk(fn.body, (n) => {
    if (isUseLiveCall(n)) found = true;
  });
  return found;
}

/** The JSX component names `fn` renders anywhere in its body. */
function renderedNames(fn: FunctionNode): Map<string, TSESTree.Node> {
  const out = new Map<string, TSESTree.Node>();
  walk(fn.body, (n) => {
    if (n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier") {
      if (!out.has(n.name.name)) out.set(n.name.name, n);
    }
  });
  return out;
}

function propertyName(node: TSESTree.Property): string | null {
  if (node.computed) return null;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal" && typeof node.key.value === "string") {
    return node.key.value;
  }
  return null;
}

export default createRule({
  name: "no-cell-live-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a live read inside a DataView field's cell — a per-row read is the " +
        "field's `rowRead`, made once by the DataView for the rows on screen.",
    },
    schema: [],
    messages: {
      cellLiveRead:
        "This cell reads live data per row{{via}}: one subscription per row mounted, so the " +
        "list's subscriptions grow with its length and with how far it is scrolled. Declare " +
        "the read on the field instead — `rowRead: rowRead({ value, params: (row) => …, " +
        "cell: (row, read) => … })` (@plugins/primitives/plugins/data-view/web) — which the " +
        "DataView makes once for the rows on screen. See plugins/primitives/plugins/data-view/CLAUDE.md " +
        "(Per-row reads).",
    },
  },
  defaultOptions: [],
  create(context) {
    /** Components declared in this file whose body calls `useLive`. */
    const reading = new Set<string>();
    const cells: { fn: FunctionNode; at: TSESTree.Node }[] = [];
    return {
      FunctionDeclaration(node) {
        if (node.id && callsUseLive(node)) reading.add(node.id.name);
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          isFunction(node.init) &&
          callsUseLive(node.init)
        ) {
          reading.add(node.id.name);
        }
      },
      Property(node) {
        const name = propertyName(node);
        if ((name === "cell" || name === "token") && isFunction(node.value)) {
          cells.push({ fn: node.value, at: node.key });
        }
      },
      "Program:exit"() {
        for (const { fn, at } of cells) {
          if (callsUseLive(fn)) {
            context.report({
              node: at,
              messageId: "cellLiveRead",
              data: { via: "" },
            });
            continue;
          }
          for (const [component] of renderedNames(fn)) {
            if (!reading.has(component)) continue;
            context.report({
              node: at,
              messageId: "cellLiveRead",
              data: { via: ` (<${component}> calls useLive)` },
            });
            break;
          }
        }
      },
    };
  },
});
