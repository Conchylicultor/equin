import {
  findImports,
  parseHostServiceDeclarations,
  providedServiceNames,
  type HostServiceDecl,
  type ImportRef,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import type TS from "typescript";
import {
  isPlatformApi,
  mayUsePlatformValue,
  platformValueUsesIn,
} from "./platform-apis";

// What one module says for portability, as the per-file scan the build keeps as
// file records (`portability.ts`). A scan's records are keyed by its module's
// whole closure (`FileScan.url`), so this module holds the scan and the code
// it runs, and nothing else.

/** A plugin's server barrel, at any nesting depth. */
export const SERVER_BARREL_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/server\/index\.ts$/;

/**
 * An import that loads its module at runtime: not `import type`, and not an
 * import whose every named binding is `type` (both erase). The same reading the
 * `boundaries/no-platform-api` lint rule makes of one file.
 */
export function loadsAtRuntime(ref: ImportRef): boolean {
  if (ref.typeOnly) return false;
  const named = /^\s*\{([^}]*)\}\s*$/.exec(ref.clause);
  if (named === null) return true;
  const bindings = named[1]!
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b !== "");
  return bindings.length === 0 || !bindings.every((b) => /^type\s/.test(b));
}

/**
 * The platform modules `src` imports and the host-only values it uses (rules 1
 * and 2). The TypeScript pass runs only on a module whose text could hold a
 * use (`mayUsePlatformValue`), so a run over thousands of modules parses the
 * few that might.
 */
export function moduleNeeds(
  ts: typeof TS,
  module: string,
  src: string,
): string[] {
  return [
    ...new Set(
      findImports(src)
        .filter((ref) => loadsAtRuntime(ref) && isPlatformApi(ref.specifier))
        .map((ref) => ref.specifier),
    ),
    ...(mayUsePlatformValue(src) ? platformValueUsesIn(ts, module, src) : []),
  ];
}

/** What one module says for portability: rules 1–2, its host-service declarations, what it provides. */
export interface ModulePortabilityFacts {
  needs: string[];
  decls: HostServiceDecl[];
  provides: string[];
}

/** One module's {@link ModulePortabilityFacts}, from its text. */
export function factsOf(
  ts: typeof TS,
  module: string,
  src: string,
): ModulePortabilityFacts {
  return {
    needs: moduleNeeds(ts, module, src),
    decls: src.includes("defineHostService")
      ? parseHostServiceDeclarations(src)
      : [],
    // Only a server barrel provides (a provider is a barrel's contribution).
    provides: SERVER_BARREL_RE.test(module) ? providedServiceNames(src) : [],
  };
}

/** Each module's {@link ModulePortabilityFacts} as a file scan, read with `ts`. */
export function portabilityFactsScan(
  ts: typeof TS,
): FileScan<ModulePortabilityFacts> {
  return { url: import.meta.url, scan: (src, rel) => factsOf(ts, rel, src) };
}
