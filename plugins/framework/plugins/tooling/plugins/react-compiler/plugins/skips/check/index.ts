import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { defineFoldCheck } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  compilerSkipsFold,
  type CompilerSkip,
  type SkipsContext,
} from "./compiler-skips.scan";

/**
 * Fails on every component or hook the React Compiler leaves uncompiled,
 * unless the plugin owning the file declares it exempt.
 *
 * When the compiler cannot compile a function (a construct it does not
 * support yet — `try/finally`, `??=`, an update to a captured variable —, a
 * hook carried as a value, a ref read in render, an eslint-disable of a
 * react-hooks rule), it emits that function unchanged: no memoization, so
 * every render re-renders its whole subtree. Nothing said so — the
 * react-hooks lint rules run the compiler with other options and report only
 * some categories — and Places' search re-rendered ~1,000 components per
 * keystroke through two such skips (report-1795084621-fswh11).
 *
 * The compiler runs with the build's own options, read off react-compiler's
 * `vite/index.ts` (the one source the artifact builder reads), over every
 * module the browser build compiles, as a fold: a pass after an edit
 * compiles only the edited files.
 */

const CHECK_ID = "react-compiler:no-silent-skips";

/** What the build hands Babel: react-compiler's `vite/` contribution. */
interface CompilerContribution {
  plugin: readonly [string, Record<string, unknown>];
}

/** The folders the browser build compiles (web-artifacts' inlined roots). */
const BROWSER_FOLDERS = new Set(["web", "core", "shared", "exhibits"]);
const SOURCE_RE = /\.tsx?$/;

function isBrowserSource(path: string): boolean {
  if (!SOURCE_RE.test(path) || path.endsWith(".d.ts")) return false;
  if (path.endsWith(".generated.ts")) return false;
  // plugins/<name>(/plugins/<name>)*/<folder>/…: the folder right below the
  // innermost plugin is what the build compiles it as.
  const segs = path.split("/");
  let i = 0;
  while (segs[i] === "plugins" && i + 2 < segs.length) {
    if (segs[i + 2] !== "plugins") return BROWSER_FOLDERS.has(segs[i + 2]!);
    i += 2;
  }
  return false;
}

async function packageVersion(main: string): Promise<string> {
  // The resolved entry sits in <pkg>/dist/; its package.json one level up.
  const pkg = JSON.parse(
    await readFile(join(dirname(main), "..", "package.json"), "utf8"),
  ) as { name: string; version: string };
  return `${pkg.name}@${pkg.version}`;
}

async function buildContext(): Promise<SkipsContext> {
  // The build's own contribution, the one file the artifact builder reads.
  const viteFile = join(
    REPO_ROOT,
    "plugins/framework/plugins/tooling/plugins/react-compiler/vite/index.ts",
  );
  const mod = (await import(viteFile)) as {
    default: (o: { repoRoot: string }) => CompilerContribution;
  };
  const [pluginPath, options] = mod.default({ repoRoot: "" }).plugin;
  // The fold compiles with this plugin's own copy of the compiler: it must be
  // the build's version, or the check judges code the build never runs.
  const ours = createRequire(import.meta.url).resolve(
    "babel-plugin-react-compiler",
  );
  const [built, checked] = await Promise.all([
    packageVersion(pluginPath),
    packageVersion(ours),
  ]);
  if (built !== checked) {
    throw new Error(
      `${CHECK_ID}: the build compiles with ${built} but this check with ${checked} — align the two package.json ranges (react-compiler and react-compiler/skips).`,
    );
  }
  const plain: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) {
    if (typeof v !== "string") {
      throw new Error(
        `${CHECK_ID}: compiler option ${k} is not a string (${JSON.stringify(v)}); the fold context holds plain strings — extend SkipsContext.`,
      );
    }
    plain[k] = v;
  }
  return { options: plain };
}

function describe(s: CompilerSkip): string {
  return `${s.path}:${s.line} ${s.fn} — ${s.category}: ${s.reason}`;
}

const check = defineFoldCheck<SkipsContext, CompilerSkip[], null>({
  id: CHECK_ID,
  description:
    "Every component and hook the browser build compiles is memoized by the React Compiler — a skipped one fails unless its plugin declares the file exempt",
  exemptable: {
    [CHECK_ID]:
      "holds a component or hook the React Compiler leaves uncompiled (no memoization: each render re-renders its whole subtree)",
  },
  outOfScope: [
    "test",
    "e2e",
    "script",
    "bin",
    "cli",
    "central",
    "provision",
    "research",
  ],
  context: () => buildContext(),
  files: (repo) => repo.under("plugins").filter(isBrowserSource),
  facts: () => null,
  fold: compilerSkipsFold,
  async verdict(skips, _inputs, ctx) {
    const exempt = await ctx.exempt(CHECK_ID);
    const offenders = skips.filter((s) => !exempt.skips(s.path));
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${offenders.length} component(s) / hook(s) the React Compiler leaves uncompiled:\n    ${offenders.map(describe).join("\n    ")}`,
      hint:
        "An uncompiled component re-renders its whole subtree on every render. Rewrite what the compiler names: " +
        "`try/finally` or a `try` without `catch` → move the async work into a plain module-level function the component calls; " +
        "`??=` → `x = x ?? v`; `x++` on a captured variable → a local or a ref; " +
        "a hook carried as a value (`props.useX()`) → resolve it into a child component that calls a fixed hook; " +
        "`Existing memoization could not be preserved` → drop the hand-written useMemo/useCallback and let the compiler memoize; " +
        "an eslint-disable of react-hooks/exhaustive-deps or rules-of-hooks makes the compiler skip the function holding it, and a BLOCK `/* eslint-disable … */` every function of its file — fix the rule instead, or use a next-line disable. " +
        `When the skip is deliberate or tracked, the plugin owning the file declares it in its own \`exempt/index.ts\` (rule \`${CHECK_ID}\`). ` +
        "To see what a skip costs on a real interaction: plugins/framework/plugins/tooling/plugins/react-compiler/plugins/skips/e2e/render-cost.ts.",
    };
  },
});

export default check;
