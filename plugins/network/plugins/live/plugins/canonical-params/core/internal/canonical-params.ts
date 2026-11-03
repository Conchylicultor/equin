// ONE spelling per params tuple. A live resource's params reach the substrate
// from many places — a read in the browser (`useResource` → the subscription,
// the HTTP fallback URL, the cold-start prime, the query key), a boot hydrate,
// and, on the server, every frame, HTTP read, `notify` and cascade the resource
// runtime handles — and every one of them must name the SAME tuple for one
// logical read, or a notify reaches a tuple nobody reads while the one on screen
// stays stale. Both ends of the wire apply THIS function: the server echoes the
// canonical tuple in every frame it sends, and a client that canonicalized
// differently would match none of them. A leaf (no imports), so the browser and
// the resource runtime (which may import only leaves) share one copy.
//
// Two spellings of "absent" are folded:
//
// - a key whose value is `undefined` (JSON drops it, but `URLSearchParams`
//   writes `"undefined"`, so the HTTP read would name a different tuple);
// - a DECLARED OPTIONAL param given `""` (a `liveValue`'s `"scopeId?"`): an
//   optional param is present iff it is a non-empty string. A required param's
//   `""` is left alone — it is a value, however suspicious (the
//   `live/no-sentinel-param` lint is what bans a `""` stand-in at a read site).
//
// Key order needs no folding: every params key (client and server) sorts.

/**
 * The canonical form of `params` for a resource whose optional param names are
 * `optional`: `undefined`-valued keys dropped, and `""` dropped for an optional
 * name. Returns `params` itself when nothing was dropped, so a caller's memo on
 * it holds.
 */
export function canonicalParams<P extends Record<string, string>>(
  params: P,
  optional: readonly string[] | undefined,
): P {
  let out: Record<string, string> | null = null;
  for (const k of Object.keys(params)) {
    const v = params[k] as string | undefined;
    const absent =
      v === undefined ||
      (v === "" && optional !== undefined && optional.includes(k));
    if (!absent) continue;
    out ??= { ...params };
    delete out[k];
  }
  return (out ?? params) as P;
}
