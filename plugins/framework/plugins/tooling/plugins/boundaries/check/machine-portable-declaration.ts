import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import { findImports } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { loadsAtRuntime, platformOffenders } from "./portable-closure";

const MACHINE_PORTABLE_DECLARATION = "boundaries:machine-portable-declaration";

// A module under a plugin's machine/ half, at any nesting depth.
const MACHINE_MODULE_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/machine\/.+\.tsx?$/;

/**
 * The declarations that run on every host once their barrel is portable: a
 * table's retention (its nightly sweep, or the cascade-bounded mark) and a
 * boot warm-up. Keyed by the barrel that exports them.
 */
const PORTABLE_DECLARATIONS: Record<string, readonly string[]> = {
  "@plugins/infra/plugins/retention/server": [
    "defineRetention",
    "markCascadeBounded",
  ],
  "@plugins/infra/plugins/warmup/server": ["defineWarmup"],
};

/**
 * The portable declarations `src` imports at runtime (by their exported
 * name, an `as` alias read through). A type-only binding erases, so it
 * declares nothing; an `export … from` re-export calls nothing, so it
 * declares nothing either. A namespace import (`* as warmup`) reaches every
 * name its barrel exports, so it counts as all of them.
 */
export function portableDeclarationsIn(src: string): string[] {
  const found = new Set<string>();
  for (const ref of findImports(src)) {
    const names = PORTABLE_DECLARATIONS[ref.specifier];
    if (names === undefined || ref.keyword === "export") continue;
    if (!loadsAtRuntime(ref)) continue;
    if (/^\s*\*\s+as\s/.test(ref.clause)) {
      for (const name of names) found.add(name);
      continue;
    }
    const named = /\{([^}]*)\}/.exec(ref.clause);
    if (named === null) continue;
    for (const binding of named[1]!.split(",")) {
      const b = binding.trim();
      if (b === "" || /^type\s/.test(b)) continue;
      const imported = b.split(/\s+as\s+/)[0]!.trim();
      if (names.includes(imported)) found.add(imported);
    }
  }
  return [...found].sort();
}

/** What the check reads of one run, injected so the scan is testable on a fixture. */
export interface MachineDeclarationScan {
  /** Every repo path in the run. */
  paths: readonly string[];
  read: (path: string) => Promise<string | null>;
  /** Whether `module`'s static closure reaches a platform API. */
  reachesPlatform: (module: string) => Promise<boolean>;
  /** Whether `module` carries a sanctioned exemption. */
  skips: (module: string) => boolean;
}

/**
 * Every non-test `machine/` module that declares a portable retention /
 * warm-up while its closure reaches no platform API, as a failure line.
 */
export async function misplacedMachineDeclarations(
  scan: MachineDeclarationScan,
): Promise<string[]> {
  const failures: string[] = [];
  const candidates = scan.paths.filter(
    (p) => MACHINE_MODULE_RE.test(p) && !isTestCodePath(p.split("/")),
  );
  for (const module of candidates) {
    const declared = portableDeclarationsIn((await scan.read(module)) ?? "");
    if (declared.length === 0) continue;
    if (scan.skips(module) || (await scan.reachesPlatform(module))) continue;
    failures.push(
      `${module} declares ${declared.join(", ")} and its closure reaches no platform API`,
    );
  }
  return failures;
}

/**
 * A retention or warm-up declared in `machine/` runs on the desktop only —
 * which is right only when it needs the computer. Retention and warm-up are
 * portable (`infra/retention`, `infra/warmup`: each host runs them, and the
 * host says which warm-ups it admits), so a declaration whose own code reaches
 * no platform API belongs in `server/`, where the browser host runs it too.
 * Splitting it into `machine/` silently drops it from every browser host.
 *
 * Read per declaring module, not per barrel, so a machine half that holds both
 * a real platform job and a portable sweep is still caught: each declaring
 * module's static closure (`importClosure`, dynamic imports cut) is scanned
 * with `boundaries:portable-closure`'s matcher, and a module whose closure is
 * clean is reported.
 *
 * Exemptable per module, for a declaration that is desktop-only by policy
 * rather than by need: a `sanctioned` exemption naming the reason.
 */
export const machinePortableDeclarationCheck: Check = {
  id: MACHINE_PORTABLE_DECLARATION,
  description:
    "no machine/ module declares a retention (defineRetention / markCascadeBounded) or warm-up (defineWarmup) whose own static closure reaches no platform API — a portable declaration lives in server/, so every host runs it",
  exemptable: {
    [MACHINE_PORTABLE_DECLARATION]:
      "declares a portable retention / warm-up in machine/ though its closure needs no platform API (desktop-only by policy)",
  },
  async run(ctx): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const repo = await ctx.repo();
    const exempt = await ctx.exempt(MACHINE_PORTABLE_DECLARATION);

    const needs = new Map<string, string[]>();
    const failures = await misplacedMachineDeclarations({
      paths: repo.all(),
      read: (p) => repo.read(p),
      reachesPlatform: async (module) => {
        const { offenders } = await platformOffenders(
          root,
          module,
          (p) => repo.read(p),
          needs,
        );
        return offenders.length > 0;
      },
      skips: (module) => exempt.skips(module),
    });
    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: failures.join("\n  "),
      hint:
        "It declares a portable retention / warm-up; it runs on every host — move it to the plugin's " +
        "server/ half (register it from server/index.ts, which must be `portable: true`). If it is " +
        "desktop-only by policy, declare a sanctioned exemption with the reason.",
    };
  },
};
