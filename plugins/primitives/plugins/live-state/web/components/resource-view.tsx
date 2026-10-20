import type { ReactNode } from "react";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  errorOf,
  statusOf,
  type GateDataOf,
  type GateInput,
} from "../resource-utils";
import type { ResourceUnavailable } from "../../core";
import { ResourceErrorInline } from "./resource-error-inline";

export interface MatchResourceHandlers<R extends GateInput> {
  /** Rendered while loading. Default: `<Loading/>` (delayed — no flash on fast loads). */
  loading?: () => ReactNode;
  /**
   * Rendered when the load failed. `stale` is the last-known-good value if one
   * ever landed (undefined on a first-load failure), so a surface can opt to
   * keep painting content under a transient failure. `err` is a typed
   * `ResourceError` (an `Error` subclass carrying `kind`). Default:
   * `<ResourceErrorInline variant="block"/>` — the message plus Retry (or
   * Reload, when the tab is out of date).
   */
  error?: (err: Error, stale?: GateDataOf<R>) => ReactNode;
  /** The only way to reach the data — called once ready. */
  ready: (data: GateDataOf<R>) => ReactNode;
  /**
   * Rendered when the read needs the computer and the host has none
   * (a needsMachine read). Default: the read's own message, muted.
   */
  unavailable?: (message: string) => ReactNode;
}

/**
 * Exhaustive render-match over a resource result, by its `status`. There is no
 * way to reach `ready`'s data while loading or failed, and no way to skip
 * either of those states — the structural replacement for
 * `r.status === "ready" ? r.data : <default>`.
 */
export function matchResource<R extends GateInput>(
  result: R,
  handlers: MatchResourceHandlers<R>,
): ReactNode {
  switch (statusOf(result)) {
    case "ready":
      return handlers.ready(
        (result as unknown as { data: GateDataOf<R> }).data,
      );
    case "error": {
      const error = errorOf(result);
      if (handlers.error) {
        return handlers.error(
          error,
          (result as { stale?: GateDataOf<R> }).stale,
        );
      }
      const refetch = (result as { refetch?: () => Promise<void> }).refetch;
      return (
        <ResourceErrorInline error={error} refetch={refetch} variant="block" />
      );
    }
    case "loading":
      return handlers.loading ? handlers.loading() : <Loading />;
    case "unavailable": {
      const { message } = result as ResourceUnavailable;
      return handlers.unavailable ? (
        handlers.unavailable(message)
      ) : (
        <Placeholder>{message}</Placeholder>
      );
    }
  }
}

export interface ResourceViewProps<R extends GateInput> {
  resource: R;
  /** Only ever called with ready data. */
  children: (data: GateDataOf<R>) => ReactNode;
  /** Rendered while loading. Default: `<Loading/>` (delayed — no flash on fast loads). */
  fallback?: ReactNode;
  /**
   * Rendered when the load failed. `stale` is the last-known-good value if one
   * ever landed (undefined on a first-load failure). Default:
   * `<ResourceErrorInline variant="block"/>`.
   */
  errorFallback?: (err: Error, stale?: GateDataOf<R>) => ReactNode;
}

/** Component sugar over `matchResource` for the common JSX case. */
export function ResourceView<R extends GateInput>({
  resource,
  children,
  fallback,
  errorFallback,
}: ResourceViewProps<R>): ReactNode {
  return matchResource(resource, {
    ready: children,
    loading: fallback === undefined ? undefined : () => fallback,
    error: errorFallback,
  });
}
