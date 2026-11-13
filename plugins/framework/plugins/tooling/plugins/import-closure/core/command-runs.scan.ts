// Which of a module's `import()` edges are CLI command `run` thunks, as a
// per-file scan the plugin-records store keeps (`FileScan`): a function of the
// file's bytes and this module's code. Imports `typescript` itself rather than
// taking it from its caller (a parser handed in would run unkeyed); the
// consumers load it lazily, so only a pass that measures a closure pays it.
import ts from "typescript";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";

/**
 * The CLI's command-declaring function, by name. A literal, not
 * `defineCliCommand.name`: importing `framework/cli/core` would put the whole
 * CLI core in this scan's key. `command-runs.scan.test.ts` holds the two equal.
 */
export const DEFINE_CLI_COMMAND = "defineCliCommand";

/**
 * The run thunks and the other `import()` sites of one module, by specifier.
 *
 * `runs` maps a specifier to the verb path(s) whose `run` it is; `other` holds
 * every specifier some NON-run `import()` in the same file also names.
 */
export interface CommandRunScan {
  runs: Record<string, string[]>;
  other: string[];
}

/**
 * Which of a module's `import()` edges are command `run` thunks.
 *
 * A `run` edge is recognised by its SHAPE in the source, not by which file it is
 * in: an `import(<string literal>)` that is the entire body of a parameterless
 * arrow, assigned to the property `run` of the object literal passed to a
 * `defineCliCommand(…)` call. That is the canonical spelling every declaration
 * uses, and it is precisely the value `bin/register-commands.ts` — the sole
 * caller of `run()` — awaits once commander has routed to that command. Nothing
 * else in the tree invokes it: the checks that load declarations
 * (`cli:command-names-unique`, `cli:command-declarations-light`) read `name` and
 * `subcommands` and never call `run`.
 *
 * Every departure is CONSERVATIVE, never a hole. A thunk written any other way
 * (a block body, a wrapper, an aliased `defineCliCommand`) is not recognised, so
 * its edge is followed like any dynamic import and its body is charged to every
 * process that loads the declaration — a false positive at worst. A specifier
 * that ALSO appears in a non-`run` `import()` of the same file is followed too,
 * since `onResolve` cannot tell two same-specifier edges apart.
 *
 * Reads the source rather than the evaluated declaration because the bundler
 * hook sees only `(importer, specifier)`, and because the verb path a thunk
 * belongs to (`deploy converge`) is right there in the enclosing calls' `name`
 * literals. A `name` that is not a string literal is reported as `<computed>`;
 * it only labels the message.
 */
export function scanCommandRuns(file: string, source: string): CommandRunScan {
  const defineName = DEFINE_CLI_COMMAND;
  const runs = new Map<string, string[]>();
  const other = new Set<string>();
  if (!source.includes(defineName)) return { runs: {}, other: [] };

  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        const command = runThunkCommand(node, defineName);
        if (command === undefined) other.add(arg.text);
        else runs.set(arg.text, [...(runs.get(arg.text) ?? []), command]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { runs: Object.fromEntries(runs), other: [...other] };
}

/**
 * The verb path whose `run` thunk `importCall` is, or `undefined` when it is
 * not one — see {@link scanCommandRuns} for the recognised shape.
 */
function runThunkCommand(
  importCall: ts.CallExpression,
  defineName: string,
): string | undefined {
  const arrow = importCall.parent;
  if (
    !ts.isArrowFunction(arrow) ||
    arrow.body !== importCall ||
    arrow.parameters.length > 0
  ) {
    return undefined;
  }
  const prop = arrow.parent;
  if (
    !ts.isPropertyAssignment(prop) ||
    prop.initializer !== arrow ||
    propertyName(prop) !== "run"
  ) {
    return undefined;
  }
  if (defineCallOf(prop.parent, defineName) === undefined) return undefined;

  // Walk out from the leaf's own object literal through every enclosing
  // `defineCliCommand` (a group's `subcommands`), so a leaf reads as the verb
  // path a user types.
  const names: string[] = [];
  for (let n: ts.Node = prop.parent; !ts.isSourceFile(n); n = n.parent) {
    if (
      ts.isObjectLiteralExpression(n) &&
      defineCallOf(n, defineName) !== undefined
    ) {
      const nameProp = n.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && propertyName(p) === "name",
      );
      names.unshift(
        nameProp !== undefined && ts.isStringLiteralLike(nameProp.initializer)
          ? nameProp.initializer.text
          : "<computed>",
      );
    }
  }
  return names.join(" ");
}

/** The `defineCliCommand(obj)` call `obj` is the first argument of, if any. */
function defineCallOf(
  obj: ts.Node,
  defineName: string,
): ts.CallExpression | undefined {
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  const call = obj.parent;
  if (
    ts.isCallExpression(call) &&
    call.arguments[0] === obj &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === defineName
  ) {
    return call;
  }
  return undefined;
}

function propertyName(p: ts.PropertyAssignment): string | undefined {
  return ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)
    ? p.name.text
    : undefined;
}

/** {@link scanCommandRuns} as file records. */
export const COMMAND_RUNS_SCAN: FileScan<CommandRunScan> = {
  url: import.meta.url,
  scan: (src, rel) => scanCommandRuns(rel, src),
};
