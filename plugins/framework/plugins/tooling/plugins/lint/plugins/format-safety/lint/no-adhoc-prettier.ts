import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A `prettier` reaching a COMMAND position: at the very start of a string value
 * / template quasi, or right after a shell command separator (`\n`, `;`, `&`,
 * `|`), optionally behind `bunx ` / `npx `.
 *
 * Deliberately NOT a bare `.includes("prettier")` — that would fire on prose
 * that merely mentions the token (this rule's own message, a doc comment) and
 * on the co-located `RuleTester` test, whose invalid-case source embeds the
 * token inside a JS string preceded by a `"` quote, never a shell separator.
 *
 * The trailing `(?=\s)` is what lets the rule name its own banned token: a bare
 * `"prettier"` string — which the module-name and argv checks below need in
 * order to exist at all — sits at `^` with nothing after it, so it does not
 * match, while every real invocation (`prettier --write .`) does.
 */
const PRETTIER_COMMAND = /(?:^|[\n;&|])\s*(?:bunx\s+|npx\s+)?prettier(?=\s)/;

/**
 * Whether a callee spawns a child from an argv array (bare, or a member like
 * `Bun.spawn`). Broader than `no-adhoc-git-grep`'s copy of this helper on
 * purpose: raw `Bun.spawn` is itself lint-banned here, so the argv-array shape
 * a real prettier invocation would take is `spawnCaptured` / `spawnExpectOk` /
 * `spawnPassthrough` from `infra/spawn`, not `spawn`.
 */
const SPAWN_CALLEES = new Set([
  "spawn",
  "spawnSync",
  "spawnCaptured",
  "spawnExpectOk",
  "spawnPassthrough",
]);

function isSpawnCallee(callee: TSESTree.Expression): boolean {
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" &&
          callee.property.type === "Identifier"
        ? callee.property.name
        : null;
  return name !== null && SPAWN_CALLEES.has(name);
}

/** Whether a module specifier is prettier or one of its subpaths. */
function isPrettierModule(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value === "prettier" || value.startsWith("prettier/"))
  );
}

/**
 * Whether an argument is an argv array literal invoking the prettier CLI —
 * `["prettier", …]`, `["bunx", "prettier", …]`, `["npx", "prettier", …]`. An
 * unrelated `["bunx", "tsc"]` spawn does NOT match.
 */
function isPrettierArgv(arg: TSESTree.Node): boolean {
  if (arg.type !== "ArrayExpression") return false;
  const [first, second] = arg.elements;
  if (first?.type !== "Literal") return false;
  if (first.value === "prettier") return true;
  return (
    (first.value === "bunx" || first.value === "npx") &&
    second?.type === "Literal" &&
    second.value === "prettier"
  );
}

export default createRule({
  name: "no-adhoc-prettier",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing or spawning prettier outside the tooling/format plugin — " +
        "a second formatter entry point can emit different bytes than the build does.",
    },
    schema: [],
    messages: {
      adhocPrettier:
        "Reaching prettier directly forks the repo's byte-format authority. The build " +
        "(writer) and the in-sync / format-clean checks (readers) must emit " +
        "byte-identical output, which holds only because ONE module owns the " +
        "allowlist and the hardcoded options — a second call site with its own " +
        "options, its own resolveConfig() walk, or its own file-type predicate " +
        "breaks that by construction, and a spawned CLI adds ~500ms per invocation " +
        "on a path that formats one file per emit site. A static import is worse " +
        "still: it hoists above ensureDeps() and resolves out of the node_modules " +
        "ensureDeps exists to repair. Route through " +
        "@plugins/framework/plugins/tooling/plugins/format/core instead — " +
        "formatSource / formatIfFormattable / formatChangedSources / " +
        "findUnformatted / listChangedFormattableFiles / isFormattable.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // Case A: `import … from "prettier"` / `export … from "prettier/…"`.
      ImportDeclaration(node) {
        if (isPrettierModule(node.source.value)) {
          context.report({ node: node.source, messageId: "adhocPrettier" });
        }
      },
      // Case A (dynamic form): `await import("prettier")` — the exact shape
      // format/core owns, so it must be banned everywhere else.
      ImportExpression(node) {
        if (
          node.source.type === "Literal" &&
          isPrettierModule(node.source.value)
        ) {
          context.report({ node: node.source, messageId: "adhocPrettier" });
        }
      },
      CallExpression(node) {
        // Case A (require form).
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require"
        ) {
          const [spec] = node.arguments;
          if (spec?.type === "Literal" && isPrettierModule(spec.value)) {
            context.report({ node: spec, messageId: "adhocPrettier" });
            return;
          }
        }
        // Case B: a spawn whose argv array literal invokes the prettier CLI.
        if (!isSpawnCallee(node.callee as TSESTree.Expression)) return;
        const [firstArg] = node.arguments;
        if (firstArg && isPrettierArgv(firstArg)) {
          context.report({ node: firstArg, messageId: "adhocPrettier" });
        }
      },
      // Case C: a string literal used as a `prettier …` shell command.
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (PRETTIER_COMMAND.test(node.value)) {
          context.report({ node, messageId: "adhocPrettier" });
        }
      },
      // Case C (template form): each quasi is checked independently, so the
      // command-position anchor resets at every quasi boundary.
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          const text = quasi.value.cooked ?? quasi.value.raw;
          if (PRETTIER_COMMAND.test(text)) {
            context.report({ node: quasi, messageId: "adhocPrettier" });
            return;
          }
        }
      },
    };
  },
});
