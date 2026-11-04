import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";

// Wedge-breaker for a metadata-only git read: far above any real duration,
// because starvation under a saturated check run is what these suffer, not
// slowness. Same reasoning as `infra/worktree`'s bounds, which carry the
// measurements.
const GIT_TIMEOUT_MS = 60_000;

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await spawnCaptured(["git", ...args], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return result.stdout;
}

const APP_CSS =
  "plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css";

// Extensions Tailwind extracts class candidates from. (No .md/.mdx: our prose
// docs quote `className` in examples and must not force the scan to cover docs/.)
const SCANNABLE = /\.(tsx?|jsx?|css|html)$/;
// A file "authors utility classes" if it references them in any of these forms.
const AUTHORS = /className|class=|\bcn\(|@apply/;
// Trees that ship their own stylesheet and never load app.css. A `class=` there
// names a class the file itself defines, not a Tailwind utility, so it must not
// drag the tree into the scan scope. `prototypes/` is the only one: each
// prototype is a self-contained document served raw into an iframe (see
// `plugins/apps/plugins/prototypes`), and scanning it would also invalidate the
// cached global-CSS pass on every prototype edit.
const SELF_STYLED = /^prototypes\//;

/**
 * Extract every `@source "<glob>"` path from app.css. CSS block comments are
 * stripped first so a prose mention inside a comment is not mistaken for a real
 * directive.
 */
function declaredSources(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of code.matchAll(/@source\s+["']([^"']+)["']/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Reduce a `@source` glob to the base directory it scans. */
function sourceBaseDir(cssDir: string, glob: string): string {
  const base = glob.replace(/\/?\*\*.*$/, "").replace(/\/+$/, "");
  return resolve(cssDir, base);
}

function within(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The real invariant: every utility class *used* in source must be *present* in
 * the compiled CSS. Tailwind only emits a class it sees in a scanned file, and
 * the `@source` glob in app.css (a path relative to app.css's own location)
 * defines that scan scope. So the structural guarantee is: every file that
 * authors a utility class must lie within the resolved scan scope.
 *
 * This supersedes the older "@source must resolve to <root>/plugins" path-pin —
 * that checked one known cause (a wrong ../ depth) under one assumption (all
 * classes live under plugins/). This checks the effect directly: relocate the
 * stylesheet, add a narrower second @source, or author a className in a new
 * top-level dir, and any class left outside the scan is flagged — whatever the
 * cause. (It was a wrong ../ depth that silently narrowed the scan to
 * plugins/primitives/plugins and dropped max-w-reading from conversations/.)
 *
 * Only out-of-scope files are read, so the common (correct) case touches almost
 * no disk.
 */
const check: Check = {
  id: "tailwind-scan-covers-classes",
  description:
    "Every file that authors a utility class must lie within Tailwind's resolved @source scan scope in app.css (else the class is silently never generated)",
  async run() {
    const root = await getWorktreeRoot();
    const cssPath = join(root, APP_CSS);
    const cssDir = dirname(cssPath);
    const css = readFileSync(cssPath, "utf8");

    // The @source list below is the whole story only while automatic source
    // detection is off. Auto-detection scans from the VITE ROOT — and the
    // artifact-mode global-css pass builds with the repo root as vite root, so
    // on the main checkout it walked `.claude/worktrees/` (~90 agent checkouts,
    // millions of files; oxide's walkdir does not honor .gitignore), turning a
    // ~5s Tailwind pass into ~320s. `source(none)` is the off switch; without
    // it the crawl comes back silently, so its absence is a check failure.
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const tailwindImport = code.match(/@import\s+["']tailwindcss["']([^;]*);/);
    if (
      !tailwindImport ||
      !/\bsource\(\s*none\s*\)/.test(tailwindImport[1] ?? "")
    ) {
      return {
        ok: false,
        message:
          `app.css must import Tailwind with automatic source detection disabled: ` +
          `@import "tailwindcss" source(none);. Auto-detection scans the vite root — the repo ` +
          `root in the artifact-mode global-css pass — which on main crawls every agent ` +
          `worktree under .claude/worktrees/ (~320s per Tailwind pass).`,
        hint: `In ${APP_CSS}, change @import "tailwindcss"; to @import "tailwindcss" source(none); and declare scan dirs via @source.`,
      };
    }

    const sources = declaredSources(css);
    if (sources.length === 0) {
      return {
        ok: false,
        message:
          "app.css declares no @source — Tailwind has nothing to scan for class names.",
        hint: `Add @source "${relative(cssDir, join(root, "plugins"))}/"; to ${APP_CSS}.`,
      };
    }
    const scopes = sources.map((g) => sourceBaseDir(cssDir, g));

    // Only files OUTSIDE every scope can be offenders, so read just those.
    const tracked = (await git(["ls-files", "-z"], root))
      .split("\0")
      .filter(Boolean);
    const offenders: string[] = [];
    for (const relPath of tracked) {
      if (!SCANNABLE.test(relPath)) continue;
      if (SELF_STYLED.test(relPath)) continue; // styles itself → app.css is irrelevant
      const abs = join(root, relPath);
      if (scopes.some((s) => within(s, abs))) continue; // in scope → emitted, skip
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch (err) {
        // A tracked file can vanish between `git ls-files` and the read; that is
        // not an offense. Anything else is unexpected — fail loudly.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (AUTHORS.test(text)) offenders.push(relPath);
    }

    if (offenders.length > 0) {
      const shown = offenders.slice(0, 10);
      const more = offenders.length - shown.length;
      const scopeList = scopes.map((s) => relative(root, s) || ".").join(", ");
      return {
        ok: false,
        message:
          `${offenders.length} file(s) author utility classes outside Tailwind's @source scan ` +
          `scope (resolved: ${scopeList}); their classes are silently never generated: ` +
          `${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}.`,
        hint:
          `Widen the @source glob(s) in ${APP_CSS} to cover them. From app.css, the repo plugins/ ` +
          `dir is @source "${relative(cssDir, join(root, "plugins"))}/"; (or @source the repo root to cover everything).`,
      };
    }
    return { ok: true };
  },
};

export default check;
