import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchValue } from "@plugins/network/plugins/live/core";
import { activeDataBindings, type ActiveDataBinding } from "./resource";

export const putBindingBodySchema = z.object({
  payload: z.unknown(),
});
export type PutBindingBody = z.infer<typeof putBindingBodySchema>;

/** The route params that name one binding: the value's tuple is its conversation. */
interface BindingKey {
  readonly messageId: string;
  readonly tag: string;
  readonly occurrenceIndex: string;
}

const sameBinding = (b: ActiveDataBinding, k: BindingKey) =>
  b.messageId === k.messageId &&
  b.tag === k.tag &&
  String(b.occurrenceIndex) === k.occurrenceIndex;

/** The server's order (`messageId`, `tag`, `occurrenceIndex`): what the loader sorts by. */
function byKey(a: ActiveDataBinding, b: ActiveDataBinding): number {
  if (a.messageId !== b.messageId) return a.messageId < b.messageId ? -1 : 1;
  if (a.tag !== b.tag) return a.tag < b.tag ? -1 : 1;
  return a.occurrenceIndex - b.occurrenceIndex;
}

/** The conversation's bindings with one binding's payload set (added when absent). */
function withBinding(
  bindings: readonly ActiveDataBinding[],
  key: BindingKey,
  payload: unknown,
): ActiveDataBinding[] {
  return [
    ...bindings.filter((b) => !sameBinding(b, key)),
    {
      messageId: key.messageId,
      tag: key.tag,
      occurrenceIndex: Number(key.occurrenceIndex),
      payload,
    },
  ].sort(byKey);
}

/** The conversation's bindings without one binding. */
function withoutBinding(
  bindings: readonly ActiveDataBinding[],
  key: BindingKey,
): ActiveDataBinding[] {
  return bindings.filter((b) => !sameBinding(b, key));
}

// A binding is one element of its conversation's whole list (a value, not a
// collection), so the effect rewrites that conversation's tuple.
export const putBinding = defineEndpoint({
  route: "PUT /api/active-data/bindings/:conversationId/:messageId/:tag/:occurrenceIndex",
  body: putBindingBodySchema,
  effect: (on) =>
    patchValue(
      on,
      activeDataBindings,
      ({ params }) => ({ conversationId: params.conversationId }),
      (value, { params, body }) => withBinding(value, params, body.payload),
    ),
});

export const deleteBinding = defineEndpoint({
  route: "DELETE /api/active-data/bindings/:conversationId/:messageId/:tag/:occurrenceIndex",
  effect: (on) =>
    patchValue(
      on,
      activeDataBindings,
      ({ params }) => ({ conversationId: params.conversationId }),
      (value, { params }) => withoutBinding(value, params),
    ),
});
