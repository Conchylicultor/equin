import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { DeadJobsPayloadSchema } from "./resources";

export const listDeadJobs = defineEndpoint({
  route: "GET /api/jobs/dead",
  response: DeadJobsPayloadSchema,
});

export const retryJob = defineEndpoint({
  route: "POST /api/jobs/:id/retry",
  unpredicted: {
    reason: "server-decided",
    why: "the queue decides the re-queued job's new state",
  },
});

export const cancelJob = defineEndpoint({
  route: "DELETE /api/jobs/:id",
  unpredicted: {
    reason: "server-decided",
    why: "the outcome depends on the job's current state, which only the queue knows",
  },
});
