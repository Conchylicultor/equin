import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

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
 * Deliberately a leaf: string constants plus one `Request` header read, no
 * `node:*` and no db, so every runtime that needs it can import it — including
 * `e2e`, whose boundary grants `core` barrels only.
 */

/** The header naming who caused a request. Absent means an ordinary user. */
export const ORIGIN_HEADER = `${LEGACY_IDS.headerPrefix}origin`;

/** The header naming WHICH automated session, e.g. `e2e:runs-surface`. */
export const ORIGIN_SOURCE_HEADER = `${LEGACY_IDS.headerPrefix}origin-source`;

/** The only value of {@link ORIGIN_HEADER} that means "not a person". */
export const AGENT_ORIGIN = "agent";

/**
 * Stamped by `fetchEndpoint` on every WRITE to an endpoint that does not
 * declare `agentReverted`: this request records nothing an agent-write revert
 * undoes. Its reader is the agent browser's write drain, which need not wait
 * for such a request before reverting (an unstamped write — a raw `fetch`, a
 * declaring endpoint — is waited for).
 *
 * A claim, never an authority for anything else — a page can set any header it
 * likes. It is checked where it matters: {@link originOf} carries it as
 * `claimsUnreverted`, and the agent-write ledger refuses (throws) to record a
 * write whose request made the claim, so a mis-declared endpoint fails loudly
 * instead of leaving a write the revert silently missed.
 */
export const UNREVERTED_WRITE_HEADER = `${LEGACY_IDS.headerPrefix}unreverted-write`;

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
  | {
      readonly kind: "agent";
      readonly source: string;
      /**
       * The request carried {@link UNREVERTED_WRITE_HEADER}: the agent
       * browser's write drain did not wait for it, so a ledger must not
       * record it (the revert could run before it lands).
       */
      readonly claimsUnreverted: boolean;
    }
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
    claimsUnreverted: req.headers.has(UNREVERTED_WRITE_HEADER),
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

/**
 * The page-side twin of the headers: a request carries {@link ORIGIN_HEADER},
 * but the page that issues it cannot read its own request headers (the shell
 * is a static file the gateway serves), so an automated session also marks
 * every document it loads with this global before any of the page's scripts
 * run. Its reader is {@link pageOrigin}; both are stamped together by
 * {@link markAgentContext}, so a session cannot carry one without the other.
 */
const PAGE_ORIGIN_GLOBAL = "__equinAgentOrigin";

/** Who drives this page — the browser-side reading of the agent-origin mark. */
export type PageOrigin =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly source: string };

/**
 * Whether this page is driven by an automated session (an e2e script, an
 * agent's `browser_*` tab) rather than a person. For "person-only" recorders —
 * app usage, anything that measures what a human does — which must not record
 * an automated drive. Not an authority: the server still decides from the
 * request (`originOf`).
 */
export function pageOrigin(): PageOrigin {
  const source: unknown = (globalThis as Record<string, unknown>)[
    PAGE_ORIGIN_GLOBAL
  ];
  return typeof source === "string"
    ? { kind: "agent", source }
    : { kind: "user" };
}

/** The slice of a Playwright `BrowserContext` {@link markAgentContext} uses. */
export interface AgentMarkableContext {
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<unknown>;
  addInitScript(script: string): Promise<unknown>;
}

/**
 * Mark a browser context as agent-driven, both halves at once: every request
 * it issues carries {@link agentOriginHeaders} (what the server reads), and
 * every document it loads carries the page mark (what {@link pageOrigin}
 * reads). Call before the context's first page.
 */
export async function markAgentContext(
  context: AgentMarkableContext,
  source: string,
): Promise<void> {
  await context.setExtraHTTPHeaders(agentOriginHeaders(source));
  await context.addInitScript(
    `globalThis[${JSON.stringify(PAGE_ORIGIN_GLOBAL)}] = ${JSON.stringify(source)};`,
  );
}
