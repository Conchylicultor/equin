import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const SCANS = new Set(["scan", "scanSync"]);

/** Browser code has no disk: out of scope. */
const BROWSER_FOLDER = /\/(web|exhibits)\//;

/**
 * no-untimed-glob-scan
 *
 * A `Bun.Glob` scan walks directories — the call a stalled disk holds longest
 * (2026-11-03: a `scan()` over 1,529 project folders took ~12 s inside a live
 * read, 34 ms in isolation, and was recorded as the read's own time). Scan
 * through `scanGlob(pattern, cwd)` / `scanGlobSync(…)` from
 * `packages/timed-fs`, which times the scan's own steps and records a slow
 * one as an `fs-glob` wait. Type-aware: a `.scan` / `.scanSync` call on a
 * value typed `Bun.Glob`.
 */
export default createRule({
  name: "no-untimed-glob-scan",
  meta: {
    type: "problem",
    docs: {
      description:
        "Bun.Glob scans go through packages/timed-fs's scanGlob / scanGlobSync, so a scan stalled on the disk is recorded as an fs-glob wait instead of the caller's own work.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      untimed:
        '`glob.{{name}}(…)` is untimed: a disk stall inside the walk reads as the caller\'s own work. Use `{{timed}}(pattern, cwd)` from "@plugins/packages/plugins/timed-fs/core", which records a slow scan as an `fs-glob` wait.',
    },
  },
  defaultOptions: [],
  create(context) {
    if (BROWSER_FOLDER.test(context.filename)) return {};
    const services = ESLintUtils.getParserServices(context);
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !SCANS.has(callee.property.name)
        )
          return;
        const type = services.getTypeAtLocation(callee.object);
        const symbol = type.getSymbol() ?? type.aliasSymbol;
        if (symbol?.getName() !== "Glob") return;
        const decl = symbol.getDeclarations()?.[0];
        if (
          decl === undefined ||
          !/bun-types|\/bun\.d\.ts$|@types\/bun/.test(
            decl.getSourceFile().fileName,
          )
        )
          return;
        const name = callee.property.name;
        context.report({
          node,
          messageId: "untimed",
          data: { name, timed: name === "scan" ? "scanGlob" : "scanGlobSync" },
        });
      },
    };
  },
});
