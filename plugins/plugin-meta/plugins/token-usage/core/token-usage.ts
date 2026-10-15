import { readFileSync } from "fs";
import { dirname, extname, join } from "path";
import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { APP_STYLESHEET_PATH } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  createTimeSlicer,
  yieldMacrotask,
} from "@plugins/packages/plugins/macrotask-yield/core";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Keyed by app.css's text, not by root: the design system is a function of
// the stylesheet alone, so an edit to it starts a fresh resolver and every
// tree build after the first in one process reuses the compiled candidates.
const resolvers = new Map<string, Promise<Resolver>>();

function resolverFor(root: string): Promise<Resolver> {
  const cssPath = join(root, APP_STYLESHEET_PATH);
  const css = readFileSync(cssPath, "utf8");
  const key = `${dirname(cssPath)}\0${hash53(css)}`;
  let resolver = resolvers.get(key);
  if (!resolver) {
    resolver = __unstable__loadDesignSystem(css, {
      base: dirname(cssPath),
    }).then((design) => ({ design, byCandidate: new Map() }));
    resolvers.set(key, resolver);
  }
  return resolver;
}

/**
 * For each group of source files (one group per plugin), every CSS custom
 * property its text reads: each literal `var(--x)`, plus each var the Tailwind
 * classes it spells compile to (in the files marked `classes`).
 *
 * Classes are resolved by Tailwind itself, over the checkout's own app.css: the
 * candidates are what oxide — the extractor Tailwind's own CSS pass uses —
 * finds in the text, and each one's CSS is what the design system loaded from
 * app.css generates for it. So `from-categorical-1-deep` (an `@theme inline`
 * alias), `rounded-card` (an `@utility`), `hover:` variants and `/15` opacity
 * modifiers all resolve exactly as in the shipped stylesheet; there is no
 * second parser of app.css to drift from it.
 *
 * Oxide runs ONCE over every group (a per-group scan costs ~2 ms of fixed
 * overhead each, seconds over the repo); the classes that read a var are then
 * attributed back to their groups by one exact-text match. A candidate is a
 * token oxide already found, so matching its text cannot invent a class — at
 * worst it finds the same class written in a comment, which Tailwind would
 * generate CSS for too.
 */
export async function tokenVarsUsedBy(
  root: string,
  groups: readonly (readonly SourceText[])[],
): Promise<Set<string>[]> {
  const { design, byCandidate } = await resolverFor(root);

  const candidates = new Scanner({}).scanFiles(
    groups.flatMap((files) =>
      files
        .filter((f) => f.classes)
        .map(({ file, content }) => ({
          content,
          extension: extname(file).slice(1),
        })),
    ),
  );
  const fresh = candidates.filter((c) => !byCandidate.has(c));
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

  // The classes that read a var, longest first so an alternation prefers
  // `bg-muted-foreground` over its prefix `bg-muted` at the same position.
  const reading = candidates
    .filter((c) => byCandidate.get(c)!.length > 0)
    .sort((a, b) => b.length - a.length);
  const classRe =
    reading.length === 0
      ? null
      : new RegExp(
          `(?<![\\w-])(?:${reading.map(escapeRegExp).join("|")})(?![\\w-])`,
          "g",
        );

  const slice = createTimeSlicer();
  const out: Set<string>[] = [];
  for (const files of groups) {
    const vars = new Set<string>();
    for (const { content, classes } of files) {
      varsOfCss(content, vars);
      if (classRe && classes)
        for (const m of content.matchAll(classRe))
          for (const v of byCandidate.get(m[0])!) vars.add(v);
    }
    out.push(vars);
    await slice();
  }
  return out;
}
