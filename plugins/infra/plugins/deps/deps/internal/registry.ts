import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { depsEntries } from "../../core/deps.generated";
import type { Dep, DepSource } from "./dep";

/**
 * The set of declared dependencies: every plugin's `deps/index.ts` default
 * export (an array of `defineDep` values), collected by codegen into
 * `core/deps.generated.ts`. The set is known statically, so a CLI op, a check
 * or `./equin start` reads it without booting a backend.
 *
 * The Dependencies view, the `deps` CLI, the install job and the sweep read
 * only this generic set — none of them names a dependency.
 */
let loaded: Promise<Dep<DepSource>[]> | undefined;

/** Every declared dependency, in registry order. Loads the declarations once. */
export function declaredDeps(): Promise<Dep<DepSource>[]> {
  return (loaded ??= loadDeclared());
}

async function loadDeclared(): Promise<Dep<DepSource>[]> {
  // Strict: a declaration that fails to load, or a default export that is not
  // a dependency, must be loud — a quietly skipped one would read as "no such
  // dependency" everywhere.
  const deps = await loadCollectedDir<Dep<DepSource>>(depsEntries, {
    isItem: isDep,
    strict: true,
    label: "dep",
  });
  const byId = new Map<string, Dep<DepSource>>();
  for (const dep of deps) {
    const other = byId.get(dep.id);
    if (other !== undefined && other !== dep) {
      throw new Error(
        `Two dependencies are declared with id ${JSON.stringify(dep.id)} (owners ${other.owner} and ${dep.owner}). ` +
          "An id names a cache directory and a CLI argument, so it must be unique.",
      );
    }
    byId.set(dep.id, dep);
  }
  return [...byId.values()];
}

/** The declared dependency with this id; throws naming the known ids. */
export async function declaredDep(id: string): Promise<Dep<DepSource>> {
  const deps = await declaredDeps();
  const dep = deps.find((d) => d.id === id);
  if (dep === undefined) {
    throw new UnknownDepError(
      id,
      deps.map((d) => d.id),
    );
  }
  return dep;
}

function isDep(value: unknown): value is Dep<DepSource> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Dep<DepSource>>;
  return (
    typeof v.id === "string" &&
    typeof v.owner === "string" &&
    typeof v.source === "object" &&
    v.source !== null &&
    typeof v.source.kind === "string" &&
    typeof v.source.identityInputs === "function" &&
    typeof v.source.install === "function" &&
    typeof v.updates === "object"
  );
}

export class UnknownDepError extends Error {
  constructor(
    readonly id: string,
    readonly known: readonly string[],
  ) {
    super(
      `No dependency is declared with id ${JSON.stringify(id)}. ` +
        (known.length === 0
          ? "None is declared in this composition."
          : `Declared: ${known.join(", ")}.`),
    );
  }
}
