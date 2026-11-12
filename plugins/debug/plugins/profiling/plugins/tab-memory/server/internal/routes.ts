import { implement } from "@plugins/infra/plugins/endpoints/server";
import { submitTabMemorySample } from "../../core";
import { tabMemorySink } from "./sink";

export const handleTabMemorySample = implement(
  submitTabMemorySample,
  ({ body }) => {
    tabMemorySink.publish(JSON.stringify(body.sample));
  },
);
