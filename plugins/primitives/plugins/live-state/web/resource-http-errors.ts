import type {
  ContractVerdict,
  SubErrorReason,
} from "@plugins/packages/plugins/resource-protocol/core";

/**
 * A resource HTTP GET returned a non-2xx status. Typed so callers can classify
 * it: `useResource`'s `queryFn` lets it propagate to `q.error`, while the
 * cold-start prime swallows it (the WS sub-ack is the source of truth) — both
 * distinct from a schema/parse failure, which is always a real bug surfaced
 * loudly.
 */
export class ResourceHttpError extends Error {
  constructor(
    public readonly key: string,
    public readonly status: number,
    /** The server's typed reason (its JSON error body); absent from an older server. */
    public readonly reason?: SubErrorReason,
    /** On `contract-mismatch` / `unknown-key`: whether the tab is out of date. */
    public readonly verdict?: ContractVerdict,
    /** The server's detail — on `refused`, the refusal's user-readable message. */
    public readonly detail?: string,
    /** On `refused`: the refusal's code, one the read's declaration lists. */
    public readonly code?: string,
  ) {
    super(
      `Resource ${key} fetch failed: ${status}${reason !== undefined ? ` (${reason}${verdict !== undefined ? `, ${verdict}` : ""})` : ""}`,
    );
    this.name = "ResourceHttpError";
  }
}

/**
 * An HTTP resource GET returned a value the version guard rejected as stale, on
 * a `(key, params)` whose cache never held a server-vouched value.
 * `fetchOverHttp` throws this rather than settling the query on nothing
 * vouched (the "Close (state unknown)" wedge) or applying
 * the stale body (which would render old-boot data). React Query's `retry` plus
 * the next `invalidate` frame converge the legitimate same-epoch race; if the
 * retry also loses, `q.error` settles typed and visible. Swallowed by
 * `primeFromHttp` (prime is best-effort; the WS sub-ack is the source of truth).
 */
export class ResourceStaleReadError extends Error {
  constructor(
    public readonly key: string,
    public readonly bodyVersion: number,
    public readonly haveVersion: number,
    public readonly reason: "stale-version" | "stale-epoch",
  ) {
    super(
      `Resource ${key} stale read: body v${bodyVersion} vs have v${haveVersion} (${reason})`,
    );
    this.name = "ResourceStaleReadError";
  }
}
