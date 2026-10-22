import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { isServableCompositionId } from "@plugins/plugin-meta/plugins/composition/core";
import { serveCompositionEndpoint } from "../../core/endpoints";
import { buildJob } from "./run-build";

/**
 * Build and serve one composition from THIS checkout.
 *
 * There is no `isMain()` gate any more. Serving used to be a tail stage of
 * main's own build — it composed over main's artifact fleet and read main's
 * config — so every other backend had to refuse. A serve is now an ordinary
 * `./singularity build --composition <id>` of the checkout this backend runs
 * out of, publishing `<id>.<checkout>.localhost:9000`; refusing it off main
 * would refuse the case the fan-out exists for.
 */
export const handleServeComposition = implementMachine(
  serveCompositionEndpoint,
  async ({ body }) => {
    // The loud boundary under the inert toggles. A serve build provisions a
    // gateway namespace for the composition, and the main composition's
    // namespace already belongs to this checkout's own build — serving it would
    // have the build overwrite the app running it. The UI renders those toggles
    // disabled; this is what answers a request that reaches the endpoint anyway.
    if (!isServableCompositionId(body.composition)) {
      throw new HttpError(
        400,
        `"${body.composition}" is not a servable composition — its namespace belongs to ` +
          `this checkout's own build, so a serve build never provisions it.`,
      );
    }
    await buildJob.enqueue({
      trigger: "manual",
      compositions: [body.composition],
    });
  },
);
