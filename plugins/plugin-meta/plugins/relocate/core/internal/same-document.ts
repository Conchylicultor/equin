/** A JSON value in a canonical form: object keys sorted, array elements sorted. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((v) => JSON.stringify(canonical(v)))
      .sort()
      .map((s) => JSON.parse(s) as unknown);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Are two config documents the same once a plugin move is accounted for —
 * equal with arrays compared as multisets? A renamed reorder key re-sorts in a
 * regenerated catalog, so a re-rooted document and the one codegen produces
 * differ in order only.
 */
export function sameDocumentModuloOrder(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
