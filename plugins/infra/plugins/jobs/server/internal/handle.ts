import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  listJobs,
  listDeadJobs,
  retryJob,
  cancelJob,
} from "../../core/endpoints";
import { JobQueue } from "./queue";
import { loadDeadJobsList } from "./resources";

export const handleListJobs = implement(listJobs, async ({ req }) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);

  const payload = await JobQueue.get().list(limit);
  if (state && state !== "all") {
    return {
      rows: payload.rows.filter((j) => j.state === state),
      counts: payload.counts,
    };
  }
  return payload;
});

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
