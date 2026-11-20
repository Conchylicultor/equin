import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { boxLinkRetryEndpoint } from "../../core";
import { retryLink } from "./link-manager";

export const handleBoxLinkRetry = implementMachine(
  boxLinkRetryEndpoint,
  async ({ params }) => {
    const outcome = await retryLink(params.deploymentId);
    if (outcome === "not-linked") {
      throw new HttpError(
        404,
        "This instance holds no link to that deployment.",
      );
    }
  },
);
