import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { DeadJobsPayloadSchema } from "./resources";

export const listDeadJobs = defineEndpoint({
  route: "GET /api/jobs/dead",
  response: DeadJobsPayloadSchema,
});

export const retryJob = defineEndpoint({
  route: "POST /api/jobs/:id/retry",
});

export const cancelJob = defineEndpoint({
  route: "DELETE /api/jobs/:id",
});
