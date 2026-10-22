import { useCallback, useMemo } from "react";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  useFetchEndpoint,
  EndpointError,
} from "@plugins/infra/plugins/endpoints/web";
import {
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
   * stored). Stays `loading` while `enabled` is false — no identity names no
   * binding, so nothing is read.
   */
  value: ResourceResult<T | null>;
  /** Upsert the payload. No-op when `enabled` is false. */
  set: (next: T) => Promise<void>;
  /** Delete the binding. No-op when `enabled` is false. */
  clear: () => Promise<void>;
}

export function useActiveDataBinding<T>(
  schema: ZodParser<T>,
): ActiveDataBindingHandle<T> {
  const fetchEndpoint = useFetchEndpoint();
  const identity = useActiveDataIdentity();
  // Without an identity there is no conversation to read: the read is skipped
  // (nothing subscribed), and the handle below reports `loading` with
  // `enabled: false` — a caller renders a legacy log's widget off `enabled`.
  const resource = useLive(
    activeDataBindings,
    identity ? { conversationId: identity.conversationId } : null,
  );

  const value = useMemo(
    () =>
      mapResource(resource, (rows): T | null => {
        if (!identity) return null;
        const row = rows.find(
          (b) =>
            b.messageId === identity.messageId &&
            b.tag === identity.tag &&
            b.occurrenceIndex === identity.occurrenceIndex,
        );
        if (!row) return null;
        const parsed = schema.safeParse(row.payload);
        return parsed.success ? parsed.data : null;
      }),
    [identity, resource, schema],
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
