// Host services read statically, as text: which services a module declares
// (`export const X = defineHostService<…>("id")`) and which ones a barrel
// provides (`X.provide(…)` in its `contributions`). The one spelling every
// reader shares — the server-portability derivation (`boundaries/core`), the
// browser-host derivation (codegen) and `host-services:provider-placement`.

import { findMarkerCalls } from "./find-marker-calls";
import { maskSource } from "./mask-source";

/** One `export const <name> = defineHostService<…>("<id>")`. */
export interface HostServiceDecl {
  /** The exported binding a provider spells `<name>.provide(…)`. */
  name: string;
  /** The service id (`database.driver`). */
  id: string;
}

/**
 * The host services `source` declares: each genuine `defineHostService(…)` call
 * (comments and strings masked) initializing an `export const` binding. Its id
 * must be a string literal — a computed one cannot be read statically, so it
 * throws. A call outside such a binding (the function's own declaration, a
 * test's inline call) declares nothing a provider can name.
 */
export function parseHostServiceDeclarations(
  source: string,
): HostServiceDecl[] {
  const masked = maskSource(source);
  const out: HostServiceDecl[] = [];
  for (const call of findMarkerCalls(source, "defineHostService")) {
    const binding = /export\s+const\s+(\w+)\s*=\s*$/.exec(
      masked.slice(0, call.index),
    );
    if (binding === null) continue;
    const id = /^\s*"([^"]+)"/.exec(call.argsText);
    if (id === null) {
      throw new Error(
        `\`export const ${binding[1]!} = defineHostService(…)\` takes its id as a string literal — "${call.argsText.trim()}" cannot be read statically.`,
      );
    }
    out.push({ name: binding[1]!, id: id[1]! });
  }
  return out;
}

/** The bindings `source` calls `.provide(` on — the services a barrel provides. */
export function providedServiceNames(source: string): string[] {
  const masked = maskSource(source);
  return [
    ...new Set([...masked.matchAll(/\b(\w+)\.provide\(/g)].map((m) => m[1]!)),
  ].sort();
}

/**
 * Service declarations keyed by their binding name. A provider names its
 * service by that binding, so two services sharing one name would make a
 * provider ambiguous: throws, naming both.
 */
export function hostServicesByName(
  decls: Iterable<HostServiceDecl & { module: string }>,
): Map<string, HostServiceDecl & { module: string }> {
  const byName = new Map<string, HostServiceDecl & { module: string }>();
  for (const d of decls) {
    const seen = byName.get(d.name);
    if (seen !== undefined && seen.id !== d.id) {
      throw new Error(
        `Two host services are bound to the name ${d.name}: "${seen.id}" (${seen.module}) and "${d.id}" (${d.module}). A provider names its service by that binding — rename one.`,
      );
    }
    byName.set(d.name, d);
  }
  return byName;
}
