import tsPlugin from "@typescript-eslint/eslint-plugin";
import type { TSESLint } from "@typescript-eslint/utils";
import type { LintRuleDocs } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const original = tsPlugin.rules!["no-floating-promises"]!;

const GUIDANCE =
  "\n\nDo NOT silently swallow errors with .catch(() => {}) or .catch(console.error) — this hides bugs." +
  "\n\nFix: (1) `await` the promise, (2) `.catch()` with a specific handler that re-throws unknown errors, " +
  "or (3) prefix with `void` for intentional fire-and-forget (errors still surface via the global " +
  "unhandledrejection handler). See CLAUDE.md § Promise handling.";

// Annotated with the package's public rule type: the inferred type of the
// spread names typescript-eslint internals that a declaration file cannot
// reference portably (TS2883), and declaration emit is what gives the
// type-check its per-file signatures.
const rule: TSESLint.RuleModule<string, unknown[], LintRuleDocs> = {
  ...original,
  meta: {
    ...original.meta,
    // Restated, not inherited through the spread: the kind is this module's
    // own declaration (see LintRuleDocs), whatever upstream's meta carries.
    docs: {
      ...original.meta.docs,
      requiresTypeChecking: true,
    },
    messages: Object.fromEntries(
      Object.entries(original.meta.messages).map(([id, msg]) => [
        id,
        id.startsWith("floatingFix") ? msg : msg + GUIDANCE,
      ]),
    ),
  },
};

export default rule;
