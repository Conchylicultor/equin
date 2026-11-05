import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { collectTokenGroupVars } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

/**
 * Checks the SOURCE-demand class of CSS custom-property gaps: a fallback-less
 * `var(--x)` reference in any repo CSS that points at a token nothing supplies
 * (no token-group var, no `--x:` CSS declaration). Catches typos, renames, and
 * orphaned runtime-only vars. Token-group vars are read FRESH from the real
 * `defineTokenGroup` descriptors via `collectTokenGroupVars()` (codegen core),
 * not a text-parse of `group.ts` nor the frozen committed manifest.
 *
 * It does NOT catch runtime-supply gaps — e.g. a sparse tweakcn preset failing
 * to emit a token-group var it is silent on. `--font-size-caption` IS a
 * token-group key, hence in SUPPLY here; whether a given preset actually emits
 * it at runtime is the injector's job (Part A's merge base + completeness
 * assertion), not this static check.
 *
 * Disjoint from `app-css-utilities-in-sync` (which reconciles `@utility` class
 * names against custom-utilities.ts) — complementary, no overlap.
 */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

const check: Check = {
  id: "css-vars-supplied",
  description:
    "Every fallback-less var(--x) in repo CSS must reference a token supplied by a token-group schema or a CSS declaration",
  async run(ctx) {
    const root = await getWorktreeRoot();

    // Selected from the run's file set (`ctx.repo()`)'s one git-backed enumeration, never a
    // hand-rolled `git ls-files <glob>`: that lists index entries whose file the
    // worktree no longer has, so a CSS file deleted-but-not-yet-committed
    // reached `readFileSync` below and crashed the check on the author's own
    // deletion. the run's file set (`ctx.repo()`) subtracts those, and includes not-yet-tracked
    // files — so a brand-new plugin's CSS is checked from its first build.
    const cssFiles = (await ctx.repo())
      .all()
      .filter((p) => p.startsWith("plugins/") && p.endsWith(".css"));

    // DEMAND: fallback-less var(--x) references, mapped to their first file.
    const demand = new Map<string, string>();
    // SUPPLY: every token a group schema or a CSS declaration provides.
    const supply = new Set<string>();

    // SUPPLY: token-group vars computed fresh from the real `defineTokenGroup`
    // descriptors (via their web-slot contributions) — NOT the committed
    // manifest, whose static import is frozen in the ESM cache before codegen
    // rewrites it, which would make a rename pass only on the second build.
    const tokenGroupVars = await collectTokenGroupVars(root);
    for (const vars of Object.values(tokenGroupVars)) {
      for (const v of vars) supply.add(v);
    }

    for (const rel of cssFiles) {
      const code = stripComments(readFileSync(join(root, rel), "utf8"));

      // DEMAND: var(--x) or var(--x, …). 2nd group `)` ⇒ fallback-less.
      for (const m of code.matchAll(/var\(\s*(--[\w-]+)\s*(,|\))/g)) {
        const name = m[1];
        const delimiter = m[2];
        if (!name || delimiter !== ")") continue;
        if (name.startsWith("--tw-")) continue; // Tailwind internals
        if (!demand.has(name)) demand.set(name, rel);
      }

      // SUPPLY: every `--x:` declaration.
      for (const m of code.matchAll(/(--[\w-]+)\s*:/g)) {
        if (m[1]) supply.add(m[1]);
      }
    }

    const offenders = [...demand.entries()].filter(
      ([name]) => !supply.has(name),
    );
    if (offenders.length > 0) {
      const lines = offenders
        .map(([name, file]) => `  ${name} (${file})`)
        .join("\n");
      return {
        ok: false,
        message: `Fallback-less var() references with no supplier:\n${lines}`,
        hint: "Every fallback-less var(--x) must be supplied by a token-group schema (plugins/ui/plugins/tokens/.../group.ts) or a CSS declaration. Add the token, declare it in app.css, or give the reference a var(--x, <fallback>).",
      };
    }

    return { ok: true };
  },
};

export default check;
