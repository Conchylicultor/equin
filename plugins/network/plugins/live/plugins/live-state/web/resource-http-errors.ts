import type {
  ReadVerdict,
  SubErrorReason,
} from "@plugins/network/plugins/live/plugins/resource-protocol/core";

/**
 * A resource HTTP GET returned a non-2xx status. Typed so callers can classify
 * it: `useResource`'s `queryFn` lets it propagate to `q.error`, while the
 * cold-start prime swallows it (the WS sub-ack is the source of truth) — both
 * distinct from a schema/parse failure (`ResourceDecodeError`, judged by
 * build: an out-of-date tab, or a real bug surfaced loudly).
 */
export class ResourceHttpError extends Error {
  constructor(
    public readonly key: string,
    public readonly status: number,
    /** The server's typed reason (its JSON error body); absent from an older server. */
    public readonly reason?: SubErrorReason,
    /**
     * On `contract-mismatch` / `unknown-key`: whether the tab is out of date
     * (`skew`), or its page's deploy disagrees with the host (`deploy-skew`).
     */
    public readonly verdict?: ReadVerdict,
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

/**
 * A value the server sent failed this tab's schema for the resource (a zod
 * rejection, or a schema that throws while parsing). `verdict` says whose fault
 * it is, judged from this bundle's build against the build graph the server's
 * code was built from (`contractVerdict`, the same judgment a server-side
 * contract refusal carries):
 *
 * - `skew` — the tab runs another build than the server: the resource's shape
 *   moved under an open tab (an enum gained a member, a field was added). The
 *   tab is out of date; a reload fixes it. The read enters the
 *   `client-outdated` state and the app-wide Reload advice counts it.
 * - `deploy-skew` — central only: the tab runs another central build than
 *   central, and a reload would bring one central does not run either (the
 *   code this tab's page was deployed from — a worktree whose central code
 *   differs from main's — disagrees with the central that runs). No reload
 *   fixes it, so it is no reload state: a loud crash naming the two deploys.
 * - `same-build` / `unknown` — the server and this tab run the same code (or
 *   one side cannot say): the schema and the loader disagree. A real bug — it
 *   stays a loud crash.
 *
 * The cause rides `cause`; never caught to be dropped.
 */
/**
 * What a `deploy-skew` is, in the words every surface shows it with (the
 * decode error, the read's failure).
 */
export const DEPLOY_SKEW_NOTE =
  " — this page was deployed from central code that differs from the central that is running; reloading does not fix it";

export class ResourceDecodeError extends Error {
  constructor(
    public readonly key: string,
    public readonly params: Readonly<Record<string, string>>,
    public readonly verdict: ReadVerdict,
    cause: unknown,
  ) {
    super(
      `Resource ${key}: the server's value does not match this tab's schema (${verdict}${
        verdict === "deploy-skew" ? DEPLOY_SKEW_NOTE : ""
      }): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "ResourceDecodeError";
  }
}
