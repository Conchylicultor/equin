import type { FieldIdentity, FieldKind } from "./types";

/** [typeId, ...ancestors] following `extends`; cycle-guarded; unknown ids resolve to [typeId]. */
export function resolveTypeChain(
  typeId: string,
  identities: ReadonlyMap<string, FieldIdentity>,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = typeId;
  while (cur && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    cur = identities.get(cur)?.extends?.id;
  }
  return chain;
}

/**
 * A type's declared {@link FieldKind}: its own, else the nearest ancestor's
 * along `extends`. A type no identity registers (a list-local type id) is a
 * `label`.
 */
export function resolveFieldKind(
  typeId: string,
  identities: ReadonlyMap<string, FieldIdentity>,
): FieldKind {
  for (const id of resolveTypeChain(typeId, identities)) {
    const kind = identities.get(id)?.kind;
    if (kind) return kind;
  }
  return "label";
}
