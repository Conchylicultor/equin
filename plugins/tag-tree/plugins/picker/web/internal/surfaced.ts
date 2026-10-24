import { EndpointError } from "@plugins/infra/plugins/endpoints/web";

/**
 * Fire a picker write from a gesture. A refused write (an `EndpointError`)
 * is already on screen — the endpoint mutation's global toast names it — so
 * it ends here; anything else is a bug and rejects loudly.
 */
export function fireWrite(write: Promise<unknown>): void {
  void write.catch((err: unknown) => {
    if (err instanceof EndpointError) return;
    throw err;
  });
}
