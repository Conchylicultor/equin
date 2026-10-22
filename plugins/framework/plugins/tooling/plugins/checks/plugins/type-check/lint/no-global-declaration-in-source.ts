/**
 * Bans `declare global { … }` and `declare module "x" { … }` in a `.ts` /
 * `.tsx` source file: the global surface lives in `.d.ts` files only.
 *
 * Every file sees a global declaration without naming the file that makes it,
 * so the type check keys every file on it: the version of a global file is in
 * the global hash, and moving it re-checks the whole repo in one program
 * (research/2026-10-22-global-type-check-global-and-cold.md). In a source file
 * the declaration rides on everything else in it — a 1,128-line e2e script
 * holding a 4-line `interface Window` block re-checked 12.6k files on every
 * edit to its body (10 of 42 whole-repo checks on main in 30 days). In a
 * `.d.ts` that holds nothing else, an edit IS a change to the surface.
 *
 * - A value a script parks on `window` (an e2e probe, a hook a test reads)
 *   needs no global: cast where it is read and written,
 *   `(window as Window & { __probe?: Probe }).__probe` — a type, so it also
 *   works inside a `page.evaluate` callback.
 * - A real augmentation (a library's `Register` interface, a missing module's
 *   typing) goes in a declaration-only `.d.ts` beside its plugin.
 *
 * Self-contained by necessity — the ESLint config loads rule files through
 * jiti, which cannot resolve `@plugins/*`.
 */
import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

export default createRule({
  name: "no-global-declaration-in-source",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `declare global` and module augmentations outside `.d.ts` files: a source file's every edit would re-check the whole repo.",
    },
    schema: [],
    messages: {
      global:
        "A `declare global` in a source file makes every edit to this file a global change: the type check " +
        "re-checks the whole repo in one program. For a value parked on `window`, cast where it is used — " +
        "`(window as Window & { __x?: T }).__x`. A real global goes in a declaration-only `.d.ts`.",
      augmentation:
        'A `declare module "…"` in a source file makes every edit to this file a global change: the type ' +
        "check re-checks the whole repo in one program. Move it to a declaration-only `.d.ts` beside this plugin.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (/\.d\.[mc]?ts$/.test(context.filename)) return {};
    return {
      TSModuleDeclaration(node) {
        if (node.kind === "global") {
          context.report({ node, messageId: "global" });
        } else if (node.kind === "module" && node.id.type === "Literal") {
          context.report({ node, messageId: "augmentation" });
        }
      },
    };
  },
});
