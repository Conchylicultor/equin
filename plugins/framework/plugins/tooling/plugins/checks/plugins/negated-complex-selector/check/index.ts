import type { Check, RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { sliceCheckThread } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { arbitraryVariants, complexNegations } from "./scan";

/**
 * Rejects a `:not()` around a complex selector (`:not(.boundary *)`,
 * `:not(:where([data-x] *))`) in what becomes a stylesheet: plugin CSS, and the
 * Tailwind arbitrary variants (`[&:not(.x_*)]:p-2`, `_` read as a space) in
 * `.ts` / `.tsx`. A selector handed to `querySelector` / `matches` costs no
 * restyle, so plain strings are not scanned.
 *
 * Chrome invalidates the whole subtree under an element whose class or
 * attribute is named inside one, so toggling that state high in the tree
 * restyles the entire document: the `focus-ring` utilities' pointer-modality
 * negation cost 8,091 elements per keyboard ⇄ pointer flip on /agents, the
 * action bar's `:not(.floating-bar-boundary *)` ~20k per surface switch. The
 * positive ancestor form costs only the rule's subjects.
 */

function stripCssComments(src: string): string {
  // Keep the newlines, so line numbers still point at the source.
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** Whether the line holding `index` is a comment line (`//`, `/*`, ` * `). */
function onCommentLine(src: string, index: number): boolean {
  const start = src.lastIndexOf("\n", index) + 1;
  return /^\s*(\/\/|\/\*|\*)/.test(src.slice(start, index));
}

/** `rel`'s text; `rel` came from `repo`'s own listing, so null means the tree moved under the run. */
async function readListed(repo: RepoFiles, rel: string): Promise<string> {
  const text = await repo.read(rel);
  if (text === null) {
    throw new Error(
      `${rel} is in the repo's file set but could not be read — it was removed after the set was listed.`,
    );
  }
  return text;
}

const check: Check = {
  id: "negated-complex-selector",
  description:
    "No `:not()` around a complex selector (`:not(.x *)`) — Chrome restyles the whole subtree on every change of what it names; write the positive ancestor form",
  async run(ctx) {
    const repo = await ctx.repo();
    const files = repo
      .under("plugins")
      .filter((p) => /\.(css|tsx?)$/.test(p) && !/\.test\.tsx?$/.test(p));
    const texts = await Promise.all(files.map((rel) => readListed(repo, rel)));
    const offenders: string[] = [];
    for (const [i, rel] of files.entries()) {
      await sliceCheckThread();
      const raw = texts[i]!;
      if (!raw.includes(":not(")) continue;
      const css = rel.endsWith(".css");
      const src = css ? stripCssComments(raw) : raw;
      // Tailwind variants: class strings, and `@apply` in CSS.
      const variants = arbitraryVariants(src)
        .filter((v) => css || !onCommentLine(src, v.index))
        .flatMap((v) =>
          complexNegations(v.text, { underscoreIsSpace: true }).map((n) => ({
            index: v.index + n.index,
            text: n.text,
          })),
        );
      const hits = css
        ? [...complexNegations(src, { underscoreIsSpace: false }), ...variants]
        : variants;
      for (const n of hits)
        offenders.push(`  ${rel}:${lineOf(src, n.index)} — ${n.text}`);
    }
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `\`:not()\` around a complex selector:\n${offenders.join("\n")}`,
      hint:
        "Chrome cannot narrow a class or attribute inside a complex :not() to the rule's " +
        "subject, so each change of it restyles the whole subtree below (the whole document " +
        "when it sits on <html>). Name the state as an ancestor instead: " +
        "`:where(:root:not([data-x])) .y` for `.y:not([data-x] *)`, or a plain descendant " +
        "rule (`.boundary .y`) that undoes the base rule.",
    };
  },
};

export default check;
