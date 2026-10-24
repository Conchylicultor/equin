import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { listDeadJobs, retryJob, cancelJob } from "../../core/endpoints";
import { JobQueue } from "./queue";
import { loadDeadJobsList } from "./resources";

export const handleListDeadJobs = implement(listDeadJobs, async ({ req }) => {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 2000), 2000);
  return loadDeadJobsList(limit);
});

export const handleRetryJob = implement(retryJob, async ({ params }) => {
  if (!params.id) throw new HttpError(400, "id required");
  await JobQueue.get().retry(params.id);
});

export const handleCancelJob = implement(cancelJob, async ({ params }) => {
  if (!params.id) throw new HttpError(400, "id required");
  await JobQueue.get().cancel(params.id);
});
