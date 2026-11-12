import type { Namespace } from "@plugins/infra/plugins/namespace/core";

declare const heldBrand: unique symbol;

/**
 * Proof that a namespace's backend is stopped and HELD down by the gateway:
 * no backend is serving this namespace, and none can come alive (traffic gets
 * "held", never a cold start) until a deploy start releases it.
 *
 * Minted only by `holdBackendDown` (`backend-hold/server`), which returns it
 * once the gateway has confirmed the hold. Whatever destroys a namespace's
 * data — `dropDatabase` / `recreateDatabase` of `database/admin` — takes one,
 * so "drop the database while its backend can still run" has no spelling.
 */
export type HeldBackend = {
  readonly namespace: Namespace;
  readonly [heldBrand]: true;
};
