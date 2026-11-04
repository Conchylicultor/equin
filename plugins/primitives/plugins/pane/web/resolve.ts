import {
  foldResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { LiveRowResult } from "@plugins/network/plugins/live/web";

/**
 * What a pane's resolve hook answers about the entity its URL names — the same
 * four-state lookup a by-id domain read already returns (`useReport`,
 * `useEventSource`), so such a read is returned as is:
 *
 * - `pending` — not known yet;
 * - `error` — nobody could answer (with the read's `retry`, when it has one).
 *   Its own state: never folded into `pending` (a spinner forever), `found` (a
 *   body left to rediscover the failure) or `missing` (a claim about the user's
 *   data nobody made);
 * - `missing` — the read settled and there is no such entity;
 * - `found` — it exists.
 *
 * `error` is a plain `Error` (a `ResourceError` is one).
 */
export type ResolveResult =
  | { status: "pending" }
  | { status: "error"; error: Error; retry?: () => Promise<unknown> }
  | { status: "missing" }
  | { status: "found" };

const PENDING: ResolveResult = { status: "pending" };
const MISSING: ResolveResult = { status: "missing" };
const FOUND: ResolveResult = { status: "found" };

/**
 * Resolve against a live read: `isFound` decides from the ready value. A failed
 * read that still holds a last-known value (`stale`) in which the entity is
 * found resolves `found` — the body keeps painting what it has — and otherwise
 * is the `error` arm, with the read's own `refetch` as its Retry.
 */
export function resolveFrom<T>(
  result: ResourceResult<T>,
  isFound: (data: T) => boolean,
): ResolveResult {
  return foldResource(result, {
    loading: () => PENDING,
    error: (error, stale) =>
      stale !== undefined && isFound(stale)
        ? FOUND
        : { status: "error", error, retry: result.refetch },
    ready: (data) => (isFound(data) ? FOUND : MISSING),
  });
}

/** Resolve against a by-id row read (`useLive(c, { id })`): its answer, arm for arm. */
export function resolveRow<Row>(row: LiveRowResult<Row>): ResolveResult {
  switch (row.status) {
    case "loading":
      return PENDING;
    case "error":
      return row.stale !== undefined
        ? FOUND
        : { status: "error", error: row.error, retry: row.refetch };
    case "ready":
      return row.found ? FOUND : MISSING;
  }
}
