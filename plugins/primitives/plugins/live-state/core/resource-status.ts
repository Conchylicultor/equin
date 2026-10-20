/**
 * The three states every live read is in — and the one typed failure the
 * `error` state carries. Runtime-agnostic (no DOM, no React), so a core type
 * elsewhere (DataView's `readiness`) can name the readiness half of a result
 * without importing the web runtime; the web `ResourceResult` builds on these.
 *
 * `loading` — no value yet and no failure: render the loading state.
 * `error`   — the read failed; a value may still be around as `stale`.
 * `ready`   — the server vouches for `data`.
 *
 * A failure is its OWN state, never a flavour of loading: a surface that only
 * asks "is it loading?" would otherwise spin forever on a read that is never
 * going to load (the build-history incident,
 * `research/2026-09-27-global-live-resource-skew-and-error-state.md`).
 */
export type ResourceStatus = "loading" | "error" | "ready";

/**
 * Why a read failed, in the five ways a surface can act on:
 *
 * - `loader-failed`   — the server tried and threw (or refused for a reason a
 *                       reload does not fix). Retry may help; otherwise a bug.
 * - `not-found`       — the server does not serve this resource (404).
 * - `client-outdated` — this tab's bundle no longer speaks the resource's
 *                       contract (a deploy moved it, or the value it got no
 *                       longer parses). Reloading the tab is the fix.
 * - `transport`       — the request never got an answer (offline, socket
 *                       down, a stale body raced a newer one). Retry heals it.
 * - `refused`         — the server cannot answer the question as asked (the
 *                       loader threw a `ResourceRefusal`: an unknown id, an
 *                       empty range), with a `code` the read declares. The
 *                       message is the server's own, written for the reader;
 *                       retrying the same question gets the same answer, so
 *                       none is offered.
 */
export type ResourceErrorKind =
  "loader-failed" | "not-found" | "client-outdated" | "transport" | "refused";

/**
 * The typed failure on a result's `error` arm. An `Error` subclass so every
 * existing `error.message` / `instanceof Error` read keeps working; `kind` is
 * what a surface branches on, `cause` the raw thrown value (an HTTP error, a
 * `TypeError` from `fetch`, a schema error) for logs and debugging.
 *
 * `code` is the refusal's code, present exactly when `kind` is `"refused"` —
 * one of the codes the read's declaration lists (`refusals`). `C` is that
 * list as a type (a `liveValue` read's `useLive` result carries it), so a
 * surface branches on a typed code — `error.kind === "refused" &&
 * error.code === "missing"` — apart from a real failure.
 */
export class ResourceError<C extends string = string> extends Error {
  constructor(
    public readonly kind: ResourceErrorKind,
    message: string,
    public override readonly cause: unknown,
    /** The refusal's code: given iff `kind` is `"refused"`. */
    public readonly code?: C,
  ) {
    super(message);
    if ((kind === "refused") !== (code !== undefined)) {
      throw new Error(
        `ResourceError: a refusal carries a code and nothing else does ` +
          `(kind "${kind}", code ${JSON.stringify(code)}).`,
      );
    }
    this.name = "ResourceError";
  }
}

/**
 * The readiness half of a resource result — what a surface needs to render
 * loading / error / ready chrome WITHOUT the data (DataView takes it as
 * `readiness`, next to its own `rows`). Every `ResourceResult`, `LiveListResult`
 * and `LiveRowResult` is assignable to it, so a caller passes the read itself.
 */
export type ResourceReadiness =
  | { status: "loading" }
  | { status: "error"; error: ResourceError; refetch: () => Promise<void> }
  | { status: "ready" };

/**
 * The arm of a read that will not arrive here: its declaration needs the
 * computer (`needsMachine`) and the host has none behind it (an in-browser
 * server). Not `loading` (it never lands) and not `error` (nothing failed):
 * `message` is the sentence to show in its place. network/live's `useLive`
 * adds it to a needsMachine read; DataView's `readiness` and every readiness
 * gate take it.
 */
export interface ResourceUnavailable {
  status: "unavailable";
  message: string;
}
