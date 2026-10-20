import { useSyncExternalStore } from "react";
import type { IconFamily, IconFamilyId } from "../../core";

/**
 * The contributed icon families, page-global like the sprite store: published
 * by `IconFamilyHost` (from `Icons.Family`), read by `resolveIconDrawing`
 * outside React. Empty until the host publishes — a family not (yet) here is
 * skipped, so its scopes draw Material meanwhile.
 */
let families: ReadonlyMap<IconFamilyId, IconFamily> = new Map();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design, like the sprite store: one family set per document serves every surface (the list the host and the customizer render)
let snapshot: readonly IconFamily[] = [];
const listeners = new Set<() => void>();

export function subscribeFamilies(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hold `list` as the page's icon families, replacing what was held. Two
 * families with one id throw: a scope naming it would draw a guess.
 */
export function provideIconFamilies(list: readonly IconFamily[]): void {
  const next = new Map<IconFamilyId, IconFamily>();
  for (const family of list) {
    if (next.has(family.id)) {
      throw new Error(
        `[icons] icon family "${family.id}" is contributed twice`,
      );
    }
    next.set(family.id, family);
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
  return useSyncExternalStore(subscribeFamilies, () => snapshot);
}
