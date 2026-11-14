import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

// Checks used to answer questions about code with regexes over comment-masked
// text — parse-utils' maskSource / matchBracket / findImports / findMarkerCalls
// and the parsers built on them — and silently skipped what they could not
// guess (aliases, re-exports, `export *` barrels, namespace imports, wrappers):
// the check passed over the very case it exists for. `sourceAnalysis(ctx)`
// (checks/core) reads the syntax tree with the repo's own module resolution
// and is fail-closed. This rule gives the text helpers no spelling in check
// code; the checks written before it are declared debt in their own plugin's
// exempt/index.ts.

const PARSE_UTILS = "@plugins/plugin-meta/plugins/parse-utils/core";
const CHECKS_CORE = "@plugins/framework/plugins/tooling/plugins/checks/core";

/**
 * checks/core's own text reads: `maskedSource` is `maskSource` behind the
 * thread-yielding run cache — the same regex-over-masked-text read.
 * (`grepCode` / `grepImports` ask whether a token or an import SPELLING
 * appears, a question about text, and stay allowed.)
 */
const CHECKS_CORE_TEXT_READS = new Set(["maskedSource"]);

/** Whether importing `name` from `source` is a banned text read. */
function isTextRead(source: string, name: string): boolean {
  if (source === PARSE_UTILS) return !NOT_TEXT_READS.has(name);
  if (source === CHECKS_CORE) return CHECKS_CORE_TEXT_READS.has(name);
  return false;
}

/**
 * The parse-utils values check code may still import: none of them reads code.
 * Everything else the barrel exports is a source-text helper — an ALLOWLIST, so
 * a text helper added to parse-utils later is banned without touching this rule.
 */
const NOT_TEXT_READS = new Set([
  // The fs-snapshot scope a build pass reads files under.
  "assertDiskReadAllowed",
  "currentFsSnapshot",
  "runWithFsSnapshot",
  "snapshotHas",
  // A 1-based line number for an offset: arithmetic, no guess about code.
  "lineAt",
]);

/**
 * A `check/` FOLDER's own code — `<plugin>/check/…`, its `*.scan.ts` file scans
 * included — not a plugin named `check` (`…/plugins/check/cli/…`). Its tests are
 * out of scope (contributed rules are off in test files by default).
 */
const CHECK_FOLDER = /\/plugins\/(?:[^/]+\/plugins\/)*[^/]+\/check\//;
function inScope(filename: string): boolean {
  return CHECK_FOLDER.test(filename) && !/\/plugins\/check\//.test(filename);
}

/** A module specifier spelled as a literal: a string, or a template with no `${}`. */
function staticSource(node: TSESTree.Expression): string | null {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function importedName(spec: TSESTree.ImportSpecifier): string {
  return spec.imported.type === "Identifier"
    ? spec.imported.name
    : spec.imported.value;
}

export default createRule({
  name: "no-text-source-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow parse-utils' source-text helpers (maskSource, matchBracket, " +
        "findImports, findMarkerCalls, …) and checks/core's maskedSource in check/ code — read code through " +
        "checks/core's fail-closed sourceAnalysis(ctx).",
    },
    schema: [],
    messages: {
      textRead:
        "`{{name}}` reads code by guessing at its text (regexes over masked " +
        "source), and what it cannot guess it skips — an alias, a re-export, an " +
        "`export *` barrel, a namespace import or a wrapper silently escapes the " +
        "check. In check code, ask the question with `sourceAnalysis(ctx)` from " +
        "@plugins/framework/plugins/tooling/plugins/checks/core (usesOf, " +
        "bindingOf → initializerOf, literalString, valueReferences, boundConst): " +
        "it reads the syntax tree with the repo's module resolution and reports " +
        'what it could not read. See the checks CLAUDE.md, "Reading code: ' +
        '`sourceAnalysis`, not regexes", and checks/plugins/source-analysis/CLAUDE.md.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? "").split("\\").join("/");
    if (!inScope(filename)) return {};
    const report = (node: TSESTree.Node, name: string): void => {
      context.report({ node, messageId: "textRead", data: { name } });
    };
    // Locals bound to the whole checks/core barrel (`import * as cc`), whose
    // `cc.maskedSource` is the banned read.
    const checksCoreNamespaces = new Set<string>();
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (node.importKind === "type") return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            if (spec.importKind === "type") continue;
            const name = importedName(spec);
            if (isTextRead(source, name)) report(spec, name);
          } else if (source === PARSE_UTILS) {
            // `import * as pu` / a default import: every helper, unnamed.
            report(spec, `${spec.local.name} (the whole parse-utils barrel)`);
          } else if (source === CHECKS_CORE) {
            checksCoreNamespaces.add(spec.local.name);
          }
        }
      },
      ExportNamedDeclaration(node) {
        const source = node.source?.value;
        if (source === undefined || node.exportKind === "type") return;
        for (const spec of node.specifiers) {
          if (spec.exportKind === "type") continue;
          const name =
            spec.local.type === "Identifier"
              ? spec.local.name
              : spec.local.value;
          if (isTextRead(source, name)) report(spec, name);
        }
      },
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          checksCoreNamespaces.has(node.object.name) &&
          !node.computed &&
          node.property.type === "Identifier" &&
          CHECKS_CORE_TEXT_READS.has(node.property.name)
        ) {
          report(node, node.property.name);
        }
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") return;
        // `export * from` checks/core re-exports maskedSource too.
        if (
          node.source.value === PARSE_UTILS ||
          node.source.value === CHECKS_CORE
        ) {
          report(node, `export * from ${node.source.value}`);
        }
      },
      ImportExpression(node) {
        // A dynamic import of checks/core is allowed: its use (`m.maskedSource`
        // on an awaited value) has no static spelling this rule could follow,
        // and no check loads checks/core lazily.
        if (staticSource(node.source) === PARSE_UTILS) {
          report(node, "import() (the whole parse-utils barrel)");
        }
      },
    };
  },
});
