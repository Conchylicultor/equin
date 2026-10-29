import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** The checks barrel that exposes the runner alongside the read-only registry APIs. */
const CHECKS_CORE = "@plugins/framework/plugins/tooling/plugins/checks/core";

/**
 * The one banned specifier: the runner itself.
 *
 * `RunChecksOptions` lives on the same barrel and is deliberately NOT banned —
 * naming the options shape costs nothing, only invoking the runner does. Same for
 * `listAllChecks` / `scopeOf`, which read the registry without recording anything.
 * So the rule keys on the named specifier, never the module.
 */
const RUNNER_NAME = "runChecks";

export default createRule({
  name: "no-adhoc-check-runner",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing runChecks() as a value outside the check command's own " +
        "action — every other caller must spawn the check pass as its own process.",
    },
    schema: [],
    messages: {
      adhocRunner:
        "runChecks() records durable PASS entries in a GLOBAL, on-disk check " +
        "cache that a later, different process reads and " +
        "trusts without re-running the check. So it must run in a process that has " +
        "done nothing else first: a build has already imported every plugin barrel " +
        "and run codegen, which is how a wrong docs/plugins-details.md was recorded " +
        "four times and shipped through four pushes (fixed in 18126884a, but the " +
        "channel stays open for the next impure check). Spawn the check pass " +
        "instead, through the shared helper in " +
        "plugins/framework/plugins/cli/plugins/op-runtime/cli/check-subprocess.ts, " +
        "threading the host grant through grant.env(). Type-only imports are " +
        "allowed, and " +
        "RunChecksOptions / listAllChecks / scopeOf on the same barrel are not " +
        "banned — only invoking the runner is.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Local names bound to `import * as checks from "…/checks/core"` — member
    // access on these to the runner is flagged, same as the profiler-seam rule.
    const nsLocals = new Set<string>();

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        if (node.source.value !== CHECKS_CORE) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            // A per-specifier `import { type RunChecksOptions, runChecks }` still
            // reaches here for the value half; the type half carries its own kind.
            if (spec.importKind === "type") continue;
            if (
              spec.imported.type === "Identifier" &&
              spec.imported.name === RUNNER_NAME
            ) {
              context.report({ node: spec, messageId: "adhocRunner" });
            }
          } else if (spec.type === "ImportNamespaceSpecifier") {
            nsLocals.add(spec.local.name);
          }
        }
      },
      // `checks.runChecks(...)` on a namespace import of the checks barrel.
      MemberExpression(node: TSESTree.MemberExpression) {
        if (node.object.type !== "Identifier") return;
        if (!nsLocals.has(node.object.name)) return;
        const prop =
          node.property.type === "Identifier"
            ? node.property.name
            : node.property.type === "Literal" &&
                typeof node.property.value === "string"
              ? node.property.value
              : null;
        if (prop === RUNNER_NAME) {
          context.report({ node, messageId: "adhocRunner" });
        }
      },
    };
  },
});
