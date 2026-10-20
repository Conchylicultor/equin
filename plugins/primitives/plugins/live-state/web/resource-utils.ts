/**
 * Readiness combinators over resource results. These exist so no consumer ever
 * writes `r.status === "ready" ? r.data : []`, which collapses "still loading",
 * "failed" and "genuinely empty" into the same value at the exact line where
 * the distinction still exists — the root of the wrong-state-while-loading bug
 * class (enforced by the `live-state/no-pending-data-collapse` lint rule).
 *
 * Correct patterns:
 *   - one resource, JSX:        <ResourceView resource={r}>{(data) => …}</ResourceView>
 *   - one resource, expression: matchResource(r, { ready: (data) => … })
 *   - a plain value:            foldResource(r, { loading, error, ready })
 *   - several resources:        combineResources({ a, b, c }) — all-or-nothing,
 *     so a view can never render from a half-loaded snapshot
 *
 * GATE RESTRICTION: feed only whole-resource results (no `select`) into these.
 * A select-scoped subscription can settle without a re-render when the
 * selected slice is identical across the no-value→first-value boundary (a
 * selector answering `undefined`; see use-resource.ts) — a gate built on one
 * can wedge as loading forever.
 * For a select-based readiness read, pass `gate: true` to useResource instead.
 */

import { ResourceError, type ResourceStatus } from "../core";
import type { ResourceResult } from "./use-resource";

/**
 * Anything gateable on readiness: a `useResource` / `useLive` / `useLiveRow`
 * result, a `combineResources` result, a `useOptimisticResource` result — any
 * value naming its state by `status`, whose `error` arm carries the failure
 * (and, for a gate that reads values, whose `ready` arm carries `data`).
 */
export type GateInput =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready" };

/** The settled data type carried by a gateable result. */
export type GateDataOf<R> = R extends { status: "ready"; data: infer D }
  ? D
  : never;

/** The last-known-good value a gateable result's error arm may carry. */
type GateStaleOf<R> = R extends { status: "error"; stale?: infer D }
  ? D
  : never;

/**
 * `combineResources`' result: the same three states as a `ResourceResult`,
 * precedence error > loading > ready — one failed input fails the whole combine
 * (a surface never renders from a half-loaded snapshot, and never spins on a
 * read that will not load). No `stale`: a partial snapshot is not a value.
 */
export type CombinedResources<T extends Record<string, GateInput>> =
  | {
      status: "loading";
      refetch: () => Promise<void>;
    }
  | {
      status: "error";
      error: ResourceError;
      refetch: () => Promise<void>;
    }
  | {
      status: "ready";
      data: { [K in keyof T]: GateDataOf<T[K]> };
      refetch: () => Promise<void>;
    };

/** The status of any gateable result. */
export function statusOf(r: GateInput): ResourceStatus {
  return r.status;
}

/**
 * The typed error of a result in the error state. A plain `Error` (a
 * hand-built gate input) is wrapped (`loader-failed`, the raw error as
 * `cause`); a `ResourceError` passes through.
 */
export function errorOf(r: GateInput): ResourceError {
  if (r.status !== "error") {
    throw new Error("errorOf: the result is not in the error state");
  }
  const e = r.error;
  if (e instanceof ResourceError) return e;
  return new ResourceError("loader-failed", e.message, e);
}

function refetchOf(r: GateInput): (() => Promise<void>) | undefined {
  const f = (r as { refetch?: () => Promise<unknown> }).refetch;
  return f === undefined ? undefined : () => f().then(() => {});
}

/**
 * Promise.all for resource results: `loading` until EVERY input is ready, then
 * `data` carries each input's value under its key. Precedence
 * **error > loading > ready**: one failed input makes the combine `error` (with
 * the first failed input's error), even while others still load. The combine's
 * `refetch` refetches every input that can.
 *
 * Pure function — for a render-stable identity inside a component, use
 * `useCombinedResources`.
 */
export function combineResources<T extends Record<string, GateInput>>(
  inputs: T,
): CombinedResources<T> {
  let error: ResourceError | null = null;
  let loading = false;
  const refetches: (() => Promise<void>)[] = [];
  for (const r of Object.values(inputs)) {
    const status = statusOf(r);
    if (status === "error" && error === null) error = errorOf(r);
    if (status === "loading") loading = true;
    const refetch = refetchOf(r);
    if (refetch !== undefined) refetches.push(refetch);
  }
  const refetch = () => Promise.all(refetches.map((f) => f())).then(() => {});
  if (error !== null) return { status: "error", error, refetch };
  if (loading) return { status: "loading", refetch };
  const data = Object.fromEntries(
    Object.entries(inputs).map(([k, r]) => [
      k,
      (r as unknown as { data: unknown }).data,
    ]),
  ) as { [K in keyof T]: GateDataOf<T[K]> };
  return { status: "ready", data, refetch };
}

/**
 * `combineResources` with a render-stable identity: recomputes only when one
 * of the input results changes (useResource memoizes its result, so this is
 * safe to use as a useMemo/useEffect dependency).
 *
 * The set of keys must be static for a given call site (rules-of-hooks).
 */
export function useCombinedResources<T extends Record<string, GateInput>>(
  inputs: T,
): CombinedResources<T> {
  return combineResources(inputs);
}

/**
 * Derive from a resource result WITHOUT erasing its readiness: the ready arm's
 * `data` goes through `fn`, the loading and error arms pass through (the error
 * arm's `stale` value, if any, derived the same way). This is how a domain hook
 * narrows a read — e.g. a point set to its one row, `rows[0] ?? null` — while
 * still handing its caller "not known yet" and "failed" as states rather than
 * as a value that means "absent".
 *
 * Pure; `fn` runs on every call, so memoize its output at the call site when a
 * stable identity matters.
 */
export function mapResource<T, U>(
  result: ResourceResult<T>,
  fn: (data: T) => U,
): ResourceResult<U> {
  switch (result.status) {
    case "ready":
      return {
        status: "ready",
        data: fn(result.data),
        refetch: result.refetch,
      };
    case "loading":
      return result;
    case "error":
      return result.stale === undefined
        ? {
            status: "error",
            error: result.error,
            refetch: result.refetch,
          }
        : {
            status: "error",
            error: result.error,
            stale: fn(result.stale),
            refetch: result.refetch,
          };
  }
}

const NOTHING_TO_REFETCH = (): Promise<void> => Promise.resolve();

/**
 * A value already in hand, as a read: the ready arm. For a hook whose answer
 * is sometimes read from the server and sometimes derived from data the caller
 * already holds (a transcript view folding the events it draws), so both paths
 * hand back one `ResourceResult`. Never a stand-in for something not known yet
 * — that is the loading arm, which only a real read produces.
 */
export function readyResource<T>(data: T): ResourceResult<T> {
  return { status: "ready", data, refetch: NOTHING_TO_REFETCH };
}

/**
 * Refuse a ready value the consumer cannot accept: when `refuse(data)` names a
 * failure, the ready arm becomes the error arm — that failure, the refused
 * value as `stale`, the read's own `refetch` — so "the server answered, but not
 * with something I can show" renders as the failure it is, never as the value.
 * The loading and error arms pass through. (A grouping read full at its limit
 * may be missing values: a filter offering it as the complete option set
 * refuses it.)
 */
export function refuseResource<T>(
  result: ResourceResult<T>,
  refuse: (data: T) => ResourceError | null,
): ResourceResult<T> {
  switch (result.status) {
    case "loading":
    case "error":
      return result;
    case "ready": {
      const error = refuse(result.data);
      if (error === null) return result;
      return {
        status: "error",
        error,
        stale: result.data,
        refetch: result.refetch,
      };
    }
  }
}

/** The handlers of {@link foldResource} — all three required, by design. */
export interface FoldResourceHandlers<R extends GateInput, U> {
  loading: () => U;
  /** `stale` is the last-known-good value, when the result carries one. */
  error: (error: ResourceError, stale: GateStaleOf<R> | undefined) => U;
  ready: (data: GateDataOf<R>) => U;
}

/**
 * Reduce a resource result to a plain value, naming what every state yields.
 * The `.ts`-derivation twin of `matchResource`: where a value (not JSX) must
 * come out, a failure still gets its own explicit answer instead of silently
 * sharing the loading one — `error` is required, so "what do we show when this
 * failed" is a decision written at the call site.
 */
export function foldResource<R extends GateInput, U>(
  result: R,
  handlers: FoldResourceHandlers<R, U>,
): U {
  switch (statusOf(result)) {
    case "ready":
      return handlers.ready(
        (result as unknown as { data: GateDataOf<R> }).data,
      );
    case "loading":
      return handlers.loading();
    case "error":
      return handlers.error(
        errorOf(result),
        (result as { stale?: GateStaleOf<R> }).stale,
      );
  }
}
