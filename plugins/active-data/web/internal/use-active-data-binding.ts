import type { z } from "zod";
import { useCallback, useMemo } from "react";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  useFetchEndpoint,
  EndpointError,
} from "@plugins/infra/plugins/endpoints/web";
import {
  activeDataBindingKey,
  activeDataBindings,
  putBinding,
  deleteBinding,
} from "@plugins/active-data/core";
import {
  useActiveDataIdentity,
  type ActiveDataIdentity,
} from "./identity-context";

/**
 * Route params for the binding endpoints. The route templates `:occurrenceIndex`
 * as a string segment, so the numeric identity field is serialized here.
 */
function bindingParams(identity: ActiveDataIdentity) {
  return {
    conversationId: identity.conversationId,
    messageId: identity.messageId,
    tag: identity.tag,
    occurrenceIndex: String(identity.occurrenceIndex),
  };
}

export interface ActiveDataBindingHandle<T> {
  /** Whether identity is available (false in legacy logs without messageId). */
  enabled: boolean;
  /**
   * The persisted, schema-validated payload for this widget instance, as a
   * read: loading, failed, or ready with the payload (`null` when none is
   * stored). While `enabled` is false it is `ready` with `null` from the first
   * render and nothing is read — no identity names no binding (a `null` row
   * id is the row read's skip); callers branch on `enabled` first.
   */
  value: ResourceResult<T | null>;
  /** Upsert the payload. No-op when `enabled` is false. */
  set: (next: T) => Promise<void>;
  /** Delete the binding. No-op when `enabled` is false. */
  clear: () => Promise<void>;
}

export function useActiveDataBinding<T>(
  schema: z.ZodType<T>,
): ActiveDataBindingHandle<T> {
  const fetchEndpoint = useFetchEndpoint();
  const identity = useActiveDataIdentity();
  // Without an identity there is no binding to read: a `null` id is the
  // row read's skip (nothing subscribed; `ready`, not found) — a caller
  // renders a legacy log's widget off `enabled`. With one, the widget reads ITS row by its composite id
  // (`:rows`), so a write to another widget's binding reaches nothing here.
  const row = useLive(activeDataBindings, {
    id: identity ? activeDataBindingKey.encode(identity) : null,
  });

  const value = useMemo(
    (): ResourceResult<T | null> =>
      mapRow(row, (found) => {
        if (found === null) return null;
        const parsed = schema.safeParse(found.payload);
        return parsed.success ? parsed.data : null;
      }),
    [row, schema],
  );

  const set = useCallback(
    async (next: T) => {
      if (!identity) return;
      try {
        await fetchEndpoint(putBinding, bindingParams(identity), {
          body: { payload: next },
        });
      } catch (err) {
        if (err instanceof EndpointError) {
          const detail = typeof err.body === "string" ? err.body : "";
          throw new Error(
            `Save binding failed (${err.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          );
        }
        throw err;
      }
    },
    [fetchEndpoint, identity],
  );

  const clear = useCallback(async () => {
    if (!identity) return;
    try {
      await fetchEndpoint(deleteBinding, bindingParams(identity));
    } catch (err) {
      if (err instanceof EndpointError) {
        const detail = typeof err.body === "string" ? err.body : "";
        throw new Error(
          `Clear binding failed (${err.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }
      throw err;
    }
  }, [fetchEndpoint, identity]);

  return { enabled: identity !== null, value, set, clear };
}
