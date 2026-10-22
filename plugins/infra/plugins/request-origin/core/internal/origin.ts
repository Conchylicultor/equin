/**
 * Provenance for a request, and for the durable writes it causes.
 *
 * The two headers are stamped on every request an automated browser session
 * issues — set once in the e2e harness's `withBrowser`, which applies them to
 * the whole browser context, so they cover the SPA's own `fetch` calls too and
 * no script has to opt in. See
 * `research/2026-07-29-global-agent-origin-provenance-for-pages.md`.
 *
 * They were spelled out independently in three places before this plugin
 * existed (the harness, the pages agent-origin create-hook, and prose); a
 * third consumer made that a "these must agree" invariant with nothing
 * enforcing it. This is the one spelling, and the one reading.
 *
 * Deliberately a leaf: string literals plus one `Request` header read, no
 * `node:*` and no db, so every runtime that needs it can import it — including
 * `e2e`, whose boundary grants `core` barrels only.
 */

/** The header naming who caused a request. Absent means an ordinary user. */
export const ORIGIN_HEADER = "x-singularity-origin";

/** The header naming WHICH automated session, e.g. `e2e:runs-surface`. */
export const ORIGIN_SOURCE_HEADER = "x-singularity-origin-source";

/** The only value of {@link ORIGIN_HEADER} that means "not a person". */
export const AGENT_ORIGIN = "agent";

/**
 * Advisory, stamped by `fetchEndpoint` on a request to an endpoint declaring
 * `agentWrite` (its value is the declaration, e.g. `telemetry`): this write is
 * one an agent session may send to main. Its only reader is the agent
 * browser's write drain, which need not wait for such a request before
 * reverting. NEVER an authority: main's write gate reads the endpoint
 * definition, never this header — a page can set any header it likes.
 */
export const AGENT_WRITE_HEADER = "x-singularity-agent-write";

/**
 * Who caused a durable write.
 *
 * A discriminated union rather than a boolean: `agent` has to carry WHICH
 * script (that is what makes a recorded write attributable afterwards) and
 * `system` has to carry why (a job, boot propagation, a CLI verb — writes with
 * no request behind them at all). A boolean could carry neither, and a caller
 * with nothing to say would have to invent a value.
 */
export type WriteOrigin =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly source: string }
  | { readonly kind: "system"; readonly reason: string };

/**
 * The ONE interpretation of the headers. Every consumer reads provenance
 * through this, so the header contract has a single reader as well as a single
 * spelling.
 *
 * An agent request with no source header still resolves to `agent` — the
 * classification must not hinge on the optional half, or a stripped header
 * would silently downgrade a write to `user` and make it unrevertible.
 */
export function originOf(req: Request): WriteOrigin {
  if (req.headers.get(ORIGIN_HEADER) !== AGENT_ORIGIN) return { kind: "user" };
  return {
    kind: "agent",
    source: req.headers.get(ORIGIN_SOURCE_HEADER) ?? AGENT_ORIGIN,
  };
}

/** A durable write with no request behind it. `reason` names the caller. */
export function systemOrigin(reason: string): WriteOrigin {
  return { kind: "system", reason };
}

/** The headers to SEND to mark a request as agent-caused. */
export function agentOriginHeaders(source: string): Record<string, string> {
  return { [ORIGIN_HEADER]: AGENT_ORIGIN, [ORIGIN_SOURCE_HEADER]: source };
}
