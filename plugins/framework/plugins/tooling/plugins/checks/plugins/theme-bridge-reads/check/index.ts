import { matchBracket } from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { Check, RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { sliceCheckThread } from "@plugins/framework/plugins/tooling/plugins/checks/core";

/**
 * Enforces that a Tailwind `@theme inline` BRIDGE copy (`--color-input:
 * var(--input)`) is never read as a value outside `@theme` — read the runtime
 * var it copies (`var(--input)`) instead.
 *
 * Why: a bridge exists so Tailwind can generate the `bg-input` / `border-input`
 * utilities, which it INLINES as `var(--input)` — read on the element itself,
 * inside whatever theme scope it sits in. But the bridge custom property is
 * also emitted, on `:root`, where its `var(--input)` is substituted ONCE: the
 * value every element inherits is the desktop theme's. A utility or class that
 * reads the `--color-input` copy therefore ignores the scoped app theme around it
 * (`[data-theme-scope]`) and paints the desktop colour — silently, since the
 * value is a valid colour. The menu rows had exactly this bug; the input
 * focus border too.
 *
 * Scans plugin `.css` (comment-stripped, `@theme` interiors masked) and
 * `.ts` / `.tsx` (class strings: an arbitrary value or a custom-property class).
 * Only bridges that copy a runtime var are flagged — Tailwind's own static
 * palette (`--color-red-500`) is a literal, the same at every scope.
 */

function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The interiors of every `@theme` block, and the source with them blanked. */
function splitThemeBlocks(src: string): { themes: string[]; rest: string } {
  const themes: string[] = [];
  let rest = src;
  const re = /@theme\b[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    const braceStart = rest.indexOf("{", m.index);
    if (braceStart < 0) break;
    const braceEnd = matchBracket(rest, braceStart, "{", "}");
    if (braceEnd < 0) break;
    themes.push(rest.slice(braceStart + 1, braceEnd));
    rest =
      rest.slice(0, braceStart + 1) +
      " ".repeat(braceEnd - braceStart - 1) +
      rest.slice(braceEnd);
    re.lastIndex = braceEnd;
  }
  return { themes, rest };
}

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
  id: "theme-bridge-reads",
  description:
    "No `var(--color-*)` read of an `@theme inline` bridge outside `@theme` — the bridge resolves at :root and ignores scoped app themes; read the runtime var it copies",
  async run(ctx) {
    const repo = await ctx.repo();
    const files = repo.under("plugins");
    const cssFiles = files.filter((p) => p.endsWith(".css"));
    const codeFiles = files.filter(
      (p) => p.endsWith(".ts") || p.endsWith(".tsx"),
    );
    // Every read through the run's gated async set, never one blocking read
    // per file on the thread every check shares.
    const [cssTexts, codeTexts] = await Promise.all([
      Promise.all(cssFiles.map((rel) => readListed(repo, rel))),
      Promise.all(codeFiles.map((rel) => readListed(repo, rel))),
    ]);

    // Pass 1: every bridge, `--color-<name>` → the runtime var it copies.
    const bridges = new Map<string, string>();
    const cssRest = new Map<string, string>();
    for (const [i, rel] of cssFiles.entries()) {
      await sliceCheckThread();
      const { themes, rest } = splitThemeBlocks(stripCssComments(cssTexts[i]!));
      cssRest.set(rel, rest);
      for (const body of themes) {
        for (const bm of body.matchAll(
          /(--color-[\w-]+)\s*:\s*var\(\s*(--[\w-]+)\s*\)/g,
        )) {
          bridges.set(bm[1]!, bm[2]!);
        }
      }
    }

    // Pass 2: every read of one outside `@theme`.
    const offenders: string[] = [];
    const scan = async (rel: string, src: string) => {
      await sliceCheckThread();
      for (const vm of src.matchAll(/var\(\s*(--color-[\w-]+)/g)) {
        const runtime = bridges.get(vm[1]!);
        if (runtime) {
          offenders.push(
            `  ${rel}:${lineOf(src, vm.index)} — var(${vm[1]}) → read var(${runtime})`,
          );
        }
      }
    };
    for (const [rel, rest] of cssRest) await scan(rel, rest);
    for (const [i, rel] of codeFiles.entries()) await scan(rel, codeTexts[i]!);

    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `Read of a Tailwind @theme bridge copy outside @theme:\n${offenders.join("\n")}`,
      hint:
        "Read the runtime var the bridge copies (shown after →). A bridge custom " +
        "property is computed once at :root, so a `var(--color-*)` read paints the " +
        "desktop theme's value inside a scoped app theme ([data-theme-scope]).",
    };
  },
};

export default check;
