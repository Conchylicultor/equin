import type { z } from "zod";
import { useCallback, useMemo } from "react";
import { useLive, useLiveMutation } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
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
  /**
   * Upsert the payload. A predicted write: the binding reads `next` at once.
   * No-op when `enabled` is false.
   */
  set: (next: T) => void;
  /** Delete the binding (predicted likewise). No-op when `enabled` is false. */
  clear: () => void;
}

export function useActiveDataBinding<T>(
  schema: z.ZodType<T>,
): ActiveDataBindingHandle<T> {
  const put = useLiveMutation(putBinding, { label: "Widget" });
  const remove = useLiveMutation(deleteBinding, { label: "Widget" });
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
    (next: T) => {
      if (!identity) return;
      put.mutate({ params: bindingParams(identity), body: { payload: next } });
    },
    [put, identity],
  );

  const clear = useCallback(() => {
    if (!identity) return;
    remove.mutate({ params: bindingParams(identity) });
  }, [remove, identity]);

  return { enabled: identity !== null, value, set, clear };
}
