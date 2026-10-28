declare const endpointEffectBrand: unique symbol;
declare const effectOnBrand: unique symbol;

/**
 * The key an {@link EndpointEffect}'s payload is held under. Endpoints never
 * reads it: the payload's shape is `network/live`'s (its predict builders
 * mint it, its predicted-write client reads it back), and this plugin sits
 * below `network/live`, so it can only carry it. Held under a symbol, not a
 * field, so no consumer is one property away from a payload whose meaning it
 * does not own.
 */
const EFFECT_PAYLOAD = Symbol("endpoint-effect-payload");

/** What an effect is computed from: the request the write sends. */
export interface EffectRequest<TParams, TBody> {
  readonly params: TParams;
  readonly body: TBody;
}

/**
 * The predicted effect of a WRITE endpoint — what the request does to live
 * data, declared beside the route (`defineEndpoint({ …, effect })`) so every
 * surface reading that data shows it at once. OPAQUE here on purpose: the
 * endpoints plugin sits below `network/live` (live imports endpoints), so it
 * declares the slot and carries the value, and `network/live` owns what is in
 * it — its builders (`patchRow`, `removeRow`, `applyRows`, `effects`) are the
 * only meaningful way to make one, and its predicted-write client the only
 * reader. The server ignores it (`implement` serves a predicted endpoint like
 * any other).
 *
 * `TParams` / `TBody` are the endpoint's own (a phantom, contravariant: an
 * effect computed from `{ id }` fits a route whose params are `{ id }`), so a
 * builder's request callbacks are typed by the route it is declared on.
 */
export interface EndpointEffect<TParams, TBody> {
  readonly [endpointEffectBrand]: true;
  readonly [EFFECT_PAYLOAD]: unknown;
  /** Phantom, never set: carries the request type contravariantly. */
  readonly __effectRequest?: (req: EffectRequest<TParams, TBody>) => void;
}

/**
 * The typed request an effect is built ON — what `defineEndpoint` hands its
 * `effect` callback (`effect: (on) => patchRow(on, entity, …)`), carrying the
 * route's params and the body's type to every builder. Why a callback and not
 * a bare `effect: patchRow(entity, …)`: TypeScript checks a nested generic
 * call while the outer call's `Route` is still being inferred, so a bare
 * builder's request callbacks would get `params: unknown`. A callback is
 * context-sensitive: it is checked once `Route` is fixed, and each builder
 * infers the request type from `on` — its first, non-callback argument —
 * before typing its own callbacks. No value worth reading: a phantom.
 */
export interface EffectOn<TParams, TBody> {
  readonly [effectOnBrand]: true;
  /** Phantom, never set: carries the request type. */
  readonly __effectRequest?: (req: EffectRequest<TParams, TBody>) => void;
}

/** The one `EffectOn` value: the type is all it carries. */
export const EFFECT_ON = Object.freeze({}) as unknown as EffectOn<never, never>;

/**
 * Wrap a payload as an {@link EndpointEffect}. For `network/live`'s predict
 * builders only (lint `endpoints/no-endpoint-effect-internals`): any other
 * caller would mint a payload the predicted-write client cannot read.
 */
export function brandEndpointEffect<TParams, TBody>(
  payload: unknown,
): EndpointEffect<TParams, TBody> {
  return Object.freeze({
    [EFFECT_PAYLOAD]: payload,
  }) as unknown as EndpointEffect<TParams, TBody>;
}

/**
 * The payload an {@link EndpointEffect} carries, unread. For `network/live`
 * only (same lint): it validates the shape it minted.
 */
export function endpointEffectPayload(
  effect: EndpointEffect<never, never>,
): unknown {
  return (effect as unknown as { [EFFECT_PAYLOAD]: unknown })[EFFECT_PAYLOAD];
}
