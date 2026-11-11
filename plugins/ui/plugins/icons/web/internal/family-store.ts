import { useSyncExternalStore } from "react";
import type { IconFamily, IconFamilyId } from "../../core";

/**
 * The contributed icon families, page-global like the sprite store: published
 * by every `IconFamilyHost` (from `Icons.Family`) — the page's and each
 * `<PluginScope>`'s, whose plugins may be ones the page loads only for it —
 * and read by `resolveIconDrawing` outside React. The union of what every
 * mounted host holds: a family is a definition named by its id (the same
 * object wherever it is contributed), drawn only where a theme names it, so
 * holding a scope's family draws nothing new on the page. Empty until a host
 * publishes — a family not (yet) here is skipped, so its scopes draw Material
 * meanwhile.
 */
const byHost = new Map<string, readonly IconFamily[]>();
let families: ReadonlyMap<IconFamilyId, IconFamily> = new Map();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design, like the sprite store: one family set per document serves every surface (the list the host and the customizer render)
let snapshot: readonly IconFamily[] = [];
const listeners = new Set<() => void>();

export function subscribeFamilies(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hold `list` as what host `host` contributes (`null`: withdraw it), and
 * re-derive the union. One family id contributed as two different families
 * throws: a scope naming it would draw a guess.
 */
export function provideIconFamilies(
  host: string,
  list: readonly IconFamily[] | null,
): void {
  if (list === null) byHost.delete(host);
  else byHost.set(host, list);
  const next = new Map<IconFamilyId, IconFamily>();
  for (const [owner, held] of byHost) {
    const own = new Set<IconFamilyId>();
    for (const family of held) {
      if (
        own.has(family.id) ||
        (next.has(family.id) && next.get(family.id) !== family)
      ) {
        throw new Error(
          `[icons] icon family "${family.id}" is contributed twice${own.has(family.id) ? "" : ` (by host "${owner}" and another)`}`,
        );
      }
      own.add(family.id);
      next.set(family.id, family);
    }
  }
  const same =
    next.size === families.size &&
    [...next].every(([id, f]) => families.get(id) === f);
  if (same) return;
  families = next;
  snapshot = [...next.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const l of listeners) l();
}

export function iconFamily(id: IconFamilyId): IconFamily | undefined {
  return families.get(id);
}

/** Every contributed family, sorted by id. */
export function useIconFamilies(): readonly IconFamily[] {
  // In memory: a server render reads the families published so far.
  return useSyncExternalStore(
    subscribeFamilies,
    () => snapshot,
    () => snapshot,
  );
}
