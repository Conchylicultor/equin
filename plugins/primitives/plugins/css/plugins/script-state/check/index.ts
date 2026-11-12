import type { Check, RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { sliceCheckThread } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  declarations,
  stripCssComments,
  stylesheetReads,
  type Hit,
} from "./scan";

/**
 * No stylesheet selects on a script-only state attribute — one declared with
 * `defineScriptState("data-…")` (`script-state/core`): page state on a
 * high-up element that flips often (`data-input-modality` on `<html>`, every
 * keyboard ⇄ pointer switch).
 *
 * A selector naming an ancestor's attribute makes Chrome restyle every element
 * the rule could match (or the whole subtree, under `:not()`) on each change
 * of it — ~7,000 `focus-ring` hosts per flip when the rings read
 * `data-input-modality`. Scans plugin CSS (any attribute selector) and the
 * Tailwind variants in `.ts` / `.tsx` / `.css` that compile to one. The set of
 * attributes is whatever the repo declares — nothing is listed here.
 */

/** A runtime folder's script, where state is declared (not check/, lint/, e2e/). */
const RUNTIME_SOURCE = /\/(web|core|shared)\/.*\.tsx?$/;

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
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
  id: "script-state:no-stylesheet-reads",
  description:
    "No stylesheet (plugin CSS, Tailwind variant) selects on a script-only state attribute declared with defineScriptState — each flip would restyle every element the rule could match",
  async run(ctx) {
    const repo = await ctx.repo();
    const files = repo
      .under("plugins")
      .filter((p) => /\.(css|tsx?)$/.test(p) && !/\.test\.tsx?$/.test(p));
    const texts = await Promise.all(files.map((rel) => readListed(repo, rel)));

    const attributes = new Set<string>();
    const unreadable: string[] = [];
    for (const [i, rel] of files.entries()) {
      // A declaration is runtime code; tooling (this check's own hint, a lint
      // rule's message) only names the call.
      if (!RUNTIME_SOURCE.test(rel)) continue;
      const src = texts[i]!;
      for (const d of declarations(src)) {
        if (d.ok) attributes.add(d.attribute);
        else unreadable.push(`  ${rel}:${lineOf(src, d.index)} — ${d.text}`);
      }
    }
    if (unreadable.length > 0) {
      return {
        ok: false,
        message: `defineScriptState called without a string-literal attribute:\n${unreadable.join("\n")}`,
        hint: 'Pass the attribute as a literal (`defineScriptState("data-x")`): the check reads it from the source.',
      };
    }

    const offenders: string[] = [];
    for (const [i, rel] of files.entries()) {
      await sliceCheckThread();
      const raw = texts[i]!;
      const css = rel.endsWith(".css");
      const src = css ? stripCssComments(raw) : raw;
      for (const attribute of attributes) {
        if (!src.includes(attribute.slice("data-".length))) continue;
        const hits: Hit[] = stylesheetReads(src, attribute, { css });
        for (const h of hits)
          offenders.push(
            `  ${rel}:${lineOf(src, h.index)} — ${h.text} (reads ${attribute})`,
          );
      }
    }
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `Stylesheet selects on a script-only state attribute:\n${offenders.join("\n")}`,
      hint:
        "These attributes flip often on a high-up element; a rule naming one restyles every " +
        "element it could match on each flip. Read the state in script and mark only the " +
        "element(s) it affects (focus-ring reads `data-pointer-focus` off the focused element, " +
        "not `data-input-modality` off <html>). See plugins/primitives/plugins/css/plugins/script-state.",
    };
  },
};

export default check;
