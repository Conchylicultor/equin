import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { retryLaunch } from "@plugins/conversations/server";
import { retryLaunchEndpoint } from "../../core/endpoints";

export const handleRetryLaunch = implementMachine(
  retryLaunchEndpoint,
  async ({ params }) => {
    try {
      await retryLaunch(params.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(409, msg);
    }
  },
);
