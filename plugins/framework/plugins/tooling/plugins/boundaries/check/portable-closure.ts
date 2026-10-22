import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import type TS from "typescript";
import {
  importClosure,
  loadTypescript,
} from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import {
  findImports,
  isPortableServerBarrel,
  type ImportRef,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { isPlatformApi, platformValueUsesIn } from "../core/platform-apis";

const PORTABLE_CLOSURE = "boundaries:portable-closure";

// A plugin's server barrel, at any nesting depth.
const SERVER_BARREL_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/server\/index\.ts$/;

/**
 * An import that loads its module at runtime: not `import type`, and not an
 * import whose every named binding is `type` (both erase). The same reading the
 * `boundaries/no-platform-api` lint rule makes of one file.
 */
function loadsAtRuntime(ref: ImportRef): boolean {
  if (ref.typeOnly) return false;
  const named = /^\s*\{([^}]*)\}\s*$/.exec(ref.clause);
  if (named === null) return true;
  const bindings = named[1]!
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b !== "");
  return bindings.length === 0 || !bindings.every((b) => /^type\s/.test(b));
}

/** One closure module that imports a platform API or uses a host-only value, with the chain to it. */
interface Offender {
  module: string;
  /** Platform modules it imports, and host-only values it uses (`global Buffer`, `unguarded .unref()`). */
  specifiers: string[];
  chain: string[];
}

/**
 * Measure `barrel`'s static closure (dynamic imports cut: the subject is what
 * evaluates before the barrel's first statement) and return every module in it
 * that imports a platform API or uses a host-only value, with the shortest
 * chain from the barrel. `needs` memoizes each module's reading across the
 * run's barrels, whose closures overlap heavily (one parse per module).
 */
async function platformOffenders(
  root: string,
  barrel: string,
  read: (path: string) => Promise<string | null>,
  needs: Map<string, string[]>,
): Promise<{ modules: number; offenders: Offender[] }> {
  const closure = await importClosure(root, barrel, { dynamicImports: "cut" });
  const ts = await loadTypescript();
  const offenders: Offender[] = [];
  for (const module of [...closure.modules].sort()) {
    let specifiers = needs.get(module);
    if (specifiers === undefined) {
      const src = await read(module);
      if (src === null) {
        throw new Error(
          `${barrel}'s closure loads ${module}, which the run's file set cannot read.`,
        );
      }
      specifiers = moduleNeeds(ts, module, src);
      needs.set(module, specifiers);
    }
    if (specifiers.length === 0) continue;
    offenders.push({ module, specifiers, chain: closure.importChain(module) });
  }
  return { modules: closure.modules.size, offenders };
}

/** The platform modules `src` imports and the host-only values it uses. */
function moduleNeeds(ts: typeof TS, module: string, src: string): string[] {
  return [
    ...new Set(
      findImports(src)
        .filter((ref) => loadsAtRuntime(ref) && isPlatformApi(ref.specifier))
        .map((ref) => ref.specifier),
    ),
    // An import-clean module can still use a host global the browser lacks.
    ...platformValueUsesIn(ts, module, src),
  ];
}

/**
 * `portable: true` on a `ServerPluginDefinition` claims "this plugin's server
 * closure runs on every host" — the browser host loads only plugins that make
 * the claim. The per-file `boundaries/no-platform-api` lint cannot prove it: a
 * portable barrel can still import a `server/` module of another plugin that
 * reaches `pg`. So this check measures the claim transitively, with the same
 * matcher: every module the barrel statically loads (`importClosure`, the
 * bundler's own resolution) is scanned for a platform import, and each offender
 * is reported with the chain that reaches it. Each module is also read for the
 * host-only VALUES it uses (`platformValueUsesIn`: a platform global read as a
 * value, an unguarded `.unref()`), which no import names.
 *
 * Exemptable per barrel, for a plugin whose closure is being made portable in
 * steps: its debt exemption names the barrel, and goes stale (failing this
 * check) the moment the closure is clean.
 */
export const portableClosureCheck: Check = {
  id: PORTABLE_CLOSURE,
  description:
    "every server barrel declaring `portable: true` statically loads no module that imports a platform API (Node builtins, bun, pg, graphile-worker, @parcel/watcher, …) or uses a host-only value (Buffer, process, Bun, setImmediate, an unguarded .unref(), …) — its whole closure runs on every host",
  exemptable: {
    [PORTABLE_CLOSURE]:
      "declares `portable: true` while its server closure still reaches a platform API (the split into server/ + machine/ is in progress)",
  },
  async run(ctx): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const repo = await ctx.repo();
    const exempt = await ctx.exempt(PORTABLE_CLOSURE);

    const portable: string[] = [];
    for (const path of repo.all().filter((p) => SERVER_BARREL_RE.test(p))) {
      if (isPortableServerBarrel((await repo.read(path)) ?? ""))
        portable.push(path);
    }

    const failures: string[] = [];
    const needs = new Map<string, string[]>();
    for (const barrel of portable) {
      const { modules, offenders } = await platformOffenders(
        root,
        barrel,
        (p) => repo.read(p),
        needs,
      );
      if (offenders.length === 0 || exempt.skips(barrel)) continue;
      failures.push(
        `${barrel} statically loads ${modules} modules; ${offenders.length} need the computer:\n` +
          offenders
            .map(
              (o) =>
                `    ${o.module} (${o.specifiers.join(", ")})\n      via ${o.chain.join(" → ")}`,
            )
            .join("\n"),
      );
    }
    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: failures.join("\n  "),
      hint:
        "Move the code that needs the computer into its plugin's `machine/` half (reached through a host " +
        "service or a machine route), or stop importing the server module that reaches it. A type-only " +
        "import is fine — it erases. Until the closure is clean, the plugin may not claim `portable: true`.",
    };
  },
};
