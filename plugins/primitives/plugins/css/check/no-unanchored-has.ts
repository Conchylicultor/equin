import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { unanchoredHas } from "../core";

/**
 * `css:no-unanchored-has` — the stylesheet front-end of the unanchored-`:has()`
 * invariant (`css/core/unanchored-has.ts` states it and says why): the
 * compound carrying a `:has()`, and every compound after it, must name its
 * element. Its twin `layout/no-unanchored-has` applies the same predicate to
 * Tailwind class variants.
 *
 * Scope: every `*.css` under `plugins/`. A nested rule is checked as the
 * selector it resolves to (`&` → `:is(<parent>)`, no `&` → a descendant of the
 * parent), so `.a:has(x) { > * { … } }` is caught like `.a:has(x) > *`.
 */

/** Every style rule in a stylesheet: its prelude as written and the selector
 *  it resolves to under CSS nesting. At-rules are skipped (their blocks keep
 *  the enclosing rule's selector). */
export function selectorPreludes(
  css: string,
): { prelude: string; resolved: string }[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { prelude: string; resolved: string }[] = [];
  const parents: (string | null)[] = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const prelude = src.slice(start, i).trim();
      const parent = parents.at(-1) ?? null;
      if (prelude.startsWith("@") || !prelude) parents.push(parent);
      else {
        const resolved =
          parent === null
            ? prelude
            : prelude.includes("&")
              ? prelude.replaceAll("&", `:is(${parent})`)
              : `:is(${parent}) ${prelude}`;
        out.push({ prelude, resolved });
        parents.push(resolved);
      }
      start = i + 1;
    } else if (c === "}") {
      parents.pop();
      start = i + 1;
    } else if (c === ";") start = i + 1;
  }
  return out;
}

const check: Check = {
  id: "css:no-unanchored-has",
  description:
    "a :has() and every compound after it must name their element (type/class/id/attribute/&) — otherwise any DOM insertion restyles whole subtrees",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    // Keyed by file + compound: a nested rule re-reports its parent's offence.
    const offenders = new Map<string, string>();
    for (const file of repo.under("plugins")) {
      if (!file.endsWith(".css")) continue;
      const css = await repo.read(file);
      if (css === null) throw new Error(`${file}: listed but unreadable`);
      for (const { prelude, resolved } of selectorPreludes(css))
        for (const { compound, at } of unanchoredHas(resolved)) {
          const key = `${file}\0${compound}`;
          if (!offenders.has(key))
            offenders.set(
              key,
              `${file}: \`${compound}\` (${at === "has" ? "carries the :has()" : "follows a :has()"}) in \`${prelude.replace(/\s+/g, " ")}\``,
            );
        }
    }
    if (offenders.size === 0) return { ok: true };
    return {
      ok: false,
      message: `unanchored :has() — a compound naming no element at or after a :has() makes any DOM insertion restyle whole subtrees:\n${[...offenders.values()].join("\n")}`,
      hint: "Anchor the compound (a class, an attribute, a type), or have the code that knows the elements mark them and key the rule on that mark (see css/plugins/scroll: useScrollsSideways).",
    };
  },
};

export default check;
