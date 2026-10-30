import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

// Every check in a pass runs on ONE JS thread (the check runner's thread watch,
// `checks/core/thread-watch.ts`). Code that holds it holds every other check and
// every timer: the `check-thread-stall` reports. Two kinds of work held it on
// every build — a blocking syscall per file (theme-bridge-reads' readFileSync of
// every source, 2.3 s) and a whole-file parse per file in a loop that never
// yields (change-feed's TS parse, 3.3 s; investigate's re-mask, ~2 s). This rule
// gives neither a spelling in check code.

/**
 * A `check/` FOLDER's own code — `<plugin>/check/…`, not a plugin named
 * `check` (`…/plugins/check/cli/…`). Its tests are out of scope (contributed
 * rules are off in test files by default).
 */
const CHECK_FOLDER = /\/plugins\/(?:[^/]+\/plugins\/)*[^/]+\/check\//;
function inScope(filename: string): boolean {
  return CHECK_FOLDER.test(filename) && !/\/plugins\/check\//.test(filename);
}

/**
 * Calls that block the thread until the OS answers — reported when made per
 * item (see `perItem`): node:fs's synchronous
 * family, synchronous child processes, and Bun's synchronous glob scan.
 * Matched by name, as a bare call or a member call (`fs.readFileSync`,
 * `Bun.spawnSync`, `glob.scanSync`) — no other API spells these names.
 */
const BLOCKING = new Set([
  "accessSync",
  "copyFileSync",
  "cpSync",
  "existsSync",
  "fstatSync",
  "lstatSync",
  "mkdirSync",
  "mkdtempSync",
  "openSync",
  "opendirSync",
  "readFileSync",
  "readSync",
  "readdirSync",
  "readlinkSync",
  "realpathSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "statSync",
  "unlinkSync",
  "writeFileSync",
  "writeSync",
  "execSync",
  "execFileSync",
  "spawnSync",
  "scanSync",
]);

/** Whole-file synchronous parses, each with the thread-yielding, run-shared form to use. */
const SYNC_PARSE = new Map([
  ["maskSource", "maskedSource"],
  ["createSourceFile", "parsedTsSource"],
]);

const LOOPS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);
const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/**
 * Whether `node` runs once per item: inside a loop body, or inside a function
 * handed to a call (`files.map(f => …)`, `.filter`, `.forEach`, a visitor).
 * The walk stops at any other function — a named helper's own body says
 * nothing about how often it is called. A blocking call made once costs one
 * syscall; made per file it is the stall.
 */
function perItem(node: TSESTree.Node): boolean {
  let child: TSESTree.Node = node;
  for (let n = node.parent; n; child = n, n = n.parent) {
    // Only a loop's body (and a `for`'s update) runs per item; its iterable,
    // test or initializer — `for (const f of readdirSync(dir))` — runs once
    // (a `while` test re-runs, but that is a poll, not a per-file read).
    if (LOOPS.has(n.type)) {
      const loop = n as TSESTree.Node & {
        body: TSESTree.Node;
        update?: TSESTree.Node | null;
      };
      if (child === loop.body || child === loop.update) return true;
      continue;
    }
    if (FUNCTIONS.has(n.type)) {
      const parent = n.parent;
      return (
        parent?.type === "CallExpression" &&
        parent.arguments.includes(n as TSESTree.CallExpressionArgument)
      );
    }
  }
  return false;
}

function calleeName(callee: TSESTree.Expression): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property.type === "Identifier" ? callee.property.name : null;
  }
  return null;
}

export default createRule({
  name: "no-blocking-check-work",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow per-item blocking fs/process calls and any direct " +
        "maskSource / createSourceFile in check/ code: every check shares one thread.",
    },
    schema: [],
    messages: {
      blockingCall:
        "`{{name}}`, called per item, blocks the check thread until the OS " +
        "answers once per item, and every " +
        "check in the pass shares that thread (a check pass runs at background " +
        "priority, where each such call costs ~100× more). Get the file set from " +
        "`ctx.repo()` (all / has / under answer in memory) and read through " +
        "`repo.read(path)` or `node:fs/promises`; spawn with `spawnCaptured` " +
        '(infra/spawn). See checks/CLAUDE.md, "A check gets its files from ' +
        '`ctx.repo()`, and never blocks the thread".',
      syncParse:
        "`{{name}}` is a whole-file synchronous parse; called per candidate it " +
        "holds the thread every check shares for the whole loop. Use " +
        "`await {{replacement}}(…)` from checks/core: it yields the check " +
        "thread's time slice first and keeps the result for the run, so the " +
        "next pass or check reading the same file pays nothing.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? "").split("\\").join("/");
    if (!inScope(filename)) return {};
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === null) return;
        if (BLOCKING.has(name)) {
          if (!perItem(node)) return;
          context.report({ node, messageId: "blockingCall", data: { name } });
          return;
        }
        const replacement = SYNC_PARSE.get(name);
        if (replacement !== undefined) {
          context.report({
            node,
            messageId: "syncParse",
            data: { name, replacement },
          });
        }
      },
    };
  },
});
