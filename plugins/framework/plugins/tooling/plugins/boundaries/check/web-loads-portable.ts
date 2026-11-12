import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { importClosures } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import { isBunTestPath } from "@plugins/framework/plugins/tooling/plugins/test-layout/core";
import { findImports } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { resolveRepoModule } from "../core/repo-module";
import {
  platformTaint,
  type Offender,
  type PlatformTaint,
} from "../core/portability";
import { loadsAtRuntime } from "../core/portability-facts";

const WEB_LOADS_PORTABLE = "boundaries:web-loads-portable";

/**
 * A module under a plugin's `web/` or `exhibits/` folder, at any nesting
 * depth: the folders whose code runs in a browser realm (the page, a worker,
 * vitest's jsdom).
 */
const BROWSER_FOLDER_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/(?:web|exhibits)\/.+\.tsx?$/;

/**
 * Whether `path` runs in a browser realm: a `web/` or `exhibits/` module that
 * is not a bun:test file (`isBunTestPath` — the `*.test.ts` beside a source
 * runs on Bun, where the computer is there; a `web/__tests__/` suite runs in
 * jsdom, where it is not).
 */
export function runsInBrowserRealm(path: string): boolean {
  return BROWSER_FOLDER_RE.test(path) && !isBunTestPath(path);
}

/** What the check reads of one run, injected so the scan is testable on a fixture. */
export interface WebLoadsScan {
  /** Every repo path in the run. */
  paths: readonly string[];
  read: (path: string) => Promise<string | null>;
  /** Rules 1 and 2 over the union closure of `entries`. */
  taint: (entries: readonly string[]) => Promise<PlatformTaint>;
  /** Whether a violation at the browser-realm module `path` is exempted. */
  skips: (path: string) => boolean;
}

/** One non-browser module the browser realm loads whose closure needs the computer. */
export interface WebLoadViolation {
  /** The module loaded (a `core/`, `shared/` or testing module). */
  module: string;
  /** The browser-realm modules that load it at runtime, sorted. */
  loadedBy: string[];
  offenders: Offender[];
}

/**
 * Every module outside the browser folders that a browser-realm module loads
 * at runtime (the frontier: a `web/` module loading another is read at that
 * one's own imports), measured as one union closure, and each whose closure
 * needs the computer, with who loads it.
 */
export async function webLoadViolations(
  scan: WebLoadsScan,
): Promise<WebLoadViolation[]> {
  const files = new Set(scan.paths);
  const loadedBy = new Map<string, string[]>();
  for (const file of scan.paths.filter(runsInBrowserRealm).sort()) {
    const src = await scan.read(file);
    if (src === null) {
      throw new Error(`${file} is in the run's file set but cannot be read.`);
    }
    for (const ref of findImports(src)) {
      if (!loadsAtRuntime(ref)) continue;
      const target = resolveRepoModule(file, ref.specifier, (p) =>
        files.has(p),
      );
      if (target === null || BROWSER_FOLDER_RE.test(target)) continue;
      const list = loadedBy.get(target);
      if (list === undefined) loadedBy.set(target, [file]);
      else if (!list.includes(file)) list.push(file);
    }
  }
  if (loadedBy.size === 0) return [];
  const entries = [...loadedBy.keys()].sort();
  const taint = await scan.taint(entries);
  const violations: WebLoadViolation[] = [];
  for (const module of entries) {
    if (!taint.needsComputer(module)) continue;
    const by = loadedBy.get(module)!.filter((f) => !scan.skips(f));
    if (by.length === 0) continue;
    violations.push({
      module,
      loadedBy: by.sort(),
      offenders: taint.offenders(module),
    });
  }
  return violations;
}

function describe(v: WebLoadViolation): string {
  const by =
    v.loadedBy.length <= 3
      ? v.loadedBy.join(", ")
      : `${v.loadedBy.slice(0, 3).join(", ")} and ${v.loadedBy.length - 3} more`;
  const why = v.offenders
    .map(
      (o) =>
        `\n      ${o.module} needs ${o.needs.join(", ")}` +
        (o.chain.length > 1 ? ` (via ${o.chain.join(" → ")})` : ""),
    )
    .join("");
  return `${v.module}, loaded by ${by}, needs the computer:${why}`;
}

/**
 * The browser realm loads nothing that needs the computer. `web/` may import
 * `core/` and its own `shared/` (the `folders` table), and those folders are
 * held to no platform API by the `boundaries/no-platform-api` lint — but that
 * lint reads one file's own imports, and a host-only `core/` file carries a
 * `debt` exemption until it is split. So a `web/` import of such a barrel
 * passed tsc, the lint and `boundary-rules`, then threw at module eval in the
 * page or a jsdom suite (`paths/core`: `homedir()` at module scope,
 * `import.meta.dir`).
 *
 * This reads the fact instead of the label: every module outside `web/` /
 * `exhibits/` that a browser-realm module loads at runtime is measured as one
 * union closure (dynamic imports cut), tainted by rules 1 and 2 of
 * `core/portability.ts` (a platform import, a host-only value), and each one
 * whose closure needs the computer is reported with the frontier modules that
 * do and the chain to them. The bun:test files beside a `web/` source run on
 * Bun and are out of scope.
 */
export const webLoadsPortableCheck: Check = {
  id: WEB_LOADS_PORTABLE,
  description:
    "no web/ or exhibits/ module (jsdom suites included, bun:test files not) loads at runtime a core/, shared/ or testing module whose static closure needs the computer — a platform import or a host-only value (process, Buffer, import.meta.dir, …)",
  exemptable: {
    [WEB_LOADS_PORTABLE]:
      "a web/ or exhibits/ module that loads host-only code because it never runs in a browser realm (a Node driver not yet moved out of web/)",
  },
  async run(ctx): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const repo = await ctx.repo();
    const exempt = await ctx.exempt(WEB_LOADS_PORTABLE);
    const read = (p: string): Promise<string | null> => repo.read(p);
    const violations = await webLoadViolations({
      paths: repo.all(),
      read,
      taint: async (entries) =>
        platformTaint(
          await importClosures(root, entries, { dynamicImports: "cut" }),
          read,
        ),
      skips: (p) => exempt.skips(p),
    });
    if (violations.length === 0) return { ok: true };
    return {
      ok: false,
      message: violations.map(describe).join("\n  "),
      hint:
        "Browser code may load only code that runs in a browser. Move the host-only part out of the " +
        "barrel the browser imports (into server/ or machine/, or a host-only barrel such as data-dirs/ " +
        "or deps/), or stop importing it from web/ — a jsdom suite uses a fixture literal instead. A " +
        "web/ module that never runs in a browser takes a debt exemption naming its split task.",
    };
  },
};
