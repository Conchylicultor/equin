import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { dirname, extname, join } from "path";
import type { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { APP_STYLESHEET_PATH } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  createTimeSlicer,
  yieldMacrotask,
} from "@plugins/packages/plugins/macrotask-yield/core";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import { maskSource } from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/** One source file's text and path (the path picks oxide's extractor by extension). */
export interface SourceText {
  file: string;
  content: string;
  /**
   * Whether the file's words can be Tailwind classes — false for code no page
   * renders (a server), where a word like `p-2` is no class and only a literal
   * `var(--x)` counts.
   */
  classes: boolean;
}

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;

interface Resolver {
  design: DesignSystem;
  /** candidate → the vars its CSS reads (`[]` for a word that is no class). */
  byCandidate: Map<string, readonly string[]>;
}

const VAR_RE = /var\(\s*(--[\w-]+)/g;
// How many candidates one synchronous `candidatesToCss` call compiles before
// the pass yields — a cold run compiles ~3k, ~0.7 s in one block otherwise.
const CSS_CHUNK = 250;

function varsOfCss(css: string, into: Set<string>): void {
  for (const m of css.matchAll(VAR_RE)) into.add(m[1]!);
}

const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/**
 * The file's text with its comments blanked (same length): a class or a
 * `var()` named in prose styles nothing, so it is no use. CSS has only block
 * comments — `maskSource`'s JS grammar would read `url(https://…)` as one.
 */
function codeOf({ file, content }: SourceText): string {
  return extname(file) === ".css"
    ? content.replace(CSS_COMMENT_RE, (c) => " ".repeat(c.length))
    : maskSource(content, { strings: false });
}

// Keyed by app.css's text, not by root: the design system is a function of
// the stylesheet alone, so an edit to it starts a fresh resolver and every
// tree build after the first in one process reuses the compiled candidates.
const resolvers = new Map<string, Promise<Resolver>>();

// Tailwind (its compiler and oxide's native scanner) loads on the first scan,
// never with this module: the cross-refs facet imports it, and a faceted
// build whose records all hit — every boot of the faceted-tree worker after
// an ordinary push — scans nothing, yet paid ~0.1 s (1.2 s from a cold disk)
// to load it.
const tailwind = (): Promise<{
  loadDesignSystem: typeof __unstable__loadDesignSystem;
  Scanner: typeof import("@tailwindcss/oxide").Scanner;
}> =>
  Promise.all([import("@tailwindcss/node"), import("@tailwindcss/oxide")]).then(
    ([node, oxide]) => ({
      loadDesignSystem: node.__unstable__loadDesignSystem,
      Scanner: oxide.Scanner,
    }),
  );

function resolverFor(root: AppPath): Promise<Resolver> {
  const cssPath = join(root, APP_STYLESHEET_PATH);
  const css = readFileSync(cssPath, "utf8");
  const key = `${dirname(cssPath)}\0${hash53(css)}`;
  let resolver = resolvers.get(key);
  if (!resolver) {
    resolver = tailwind()
      .then(({ loadDesignSystem }) =>
        loadDesignSystem(css, { base: dirname(cssPath) }),
      )
      .then((design) => ({ design, byCandidate: new Map() }));
    resolvers.set(key, resolver);
  }
  return resolver;
}

/**
 * For each group of source files (one group per plugin), every CSS custom
 * property its code reads: each literal `var(--x)`, plus each var the Tailwind
 * classes it spells compile to (in the files marked `classes`). Comments are
 * not code: what they name is not counted.
 *
 * Classes are resolved by Tailwind itself, over the checkout's own app.css: the
 * candidates are what oxide — the extractor Tailwind's own CSS pass uses —
 * finds in the text, and each one's CSS is what the design system loaded from
 * app.css generates for it. So `from-categorical-1-deep` (an `@theme inline`
 * alias), `rounded-card` (an `@utility`), `hover:` variants and `/15` opacity
 * modifiers all resolve exactly as in the shipped stylesheet; there is no
 * second parser of app.css to drift from it.
 *
 * Each group is scanned on its own, and its classes are exactly the candidates
 * oxide finds in it: a group's answer is a function of its own files (and
 * app.css), never of what else is in the call — an incremental docgen over a
 * few plugins and a full scan over all of them agree by construction. (One
 * oxide call over every group is ~4x faster on a cold full scan, but leaves
 * only text matching to attribute its candidates back, which credits a group
 * with a class another group spells.)
 */
export async function tokenVarsUsedBy(
  root: AppPath,
  groups: readonly (readonly SourceText[])[],
): Promise<Set<string>[]> {
  const { design, byCandidate } = await resolverFor(root);
  const { Scanner } = await tailwind();

  const slice = createTimeSlicer();
  const scanned: { code: string[]; candidates: string[] }[] = [];
  for (const files of groups) {
    const code = files.map(codeOf);
    const styled = files.flatMap((f, i) =>
      f.classes
        ? [{ content: code[i]!, extension: extname(f.file).slice(1) }]
        : [],
    );
    scanned.push({
      code,
      candidates: styled.length === 0 ? [] : new Scanner({}).scanFiles(styled),
    });
    await slice();
  }

  const fresh = [
    ...new Set(
      scanned.flatMap((g) => g.candidates.filter((c) => !byCandidate.has(c))),
    ),
  ];
  for (const c of fresh)
    if (design.parseCandidate(c).length === 0) byCandidate.set(c, []);
  const toCompile = fresh.filter((c) => !byCandidate.has(c));
  for (let i = 0; i < toCompile.length; i += CSS_CHUNK) {
    const chunk = toCompile.slice(i, i + CSS_CHUNK);
    const css = design.candidatesToCss(chunk);
    chunk.forEach((c, j) => {
      const vars = new Set<string>();
      const text = css[j];
      if (text) varsOfCss(text, vars);
      byCandidate.set(c, [...vars]);
    });
    await yieldMacrotask();
  }

  return scanned.map(({ code, candidates }) => {
    const vars = new Set<string>();
    for (const text of code) varsOfCss(text, vars);
    for (const c of candidates)
      for (const v of byCandidate.get(c)!) vars.add(v);
    return vars;
  });
}
