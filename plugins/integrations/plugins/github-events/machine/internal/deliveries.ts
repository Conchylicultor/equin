import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { releasesWatched, watchFor } from "../../server";
import { catchUp, failedJobsLoader, refreshReleases } from "./catch-up";
import {
  DELIVERY_EVENTS,
  DeliverySchemas,
  failedJobOf,
  jobRunKey,
  releaseFacts,
  runFacts,
  type DeliveryEvent,
} from "./events";
import { markConnected, repoSigning } from "./forwarders";
import {
  addFailedJob,
  deleteRelease,
  reportIfFailed,
  upsertRelease,
  upsertRun,
} from "./ingest";
import { runningGh } from "./lifecycle";

function isDeliveryEvent(name: string | null): name is DeliveryEvent {
  return name !== null && (DELIVERY_EVENTS as string[]).includes(name);
}

/**
 * `POST /api/github-events/deliveries` — one GitHub delivery, posted by a
 * forwarder. The signature is checked over the raw bytes before anything is
 * parsed: a body no current forwarder signed is refused (401) and never
 * read. An event of a workflow or release nobody watches is dropped.
 */
export async function handleDelivery(req: Request): Promise<Response> {
  const body = new Uint8Array(await req.arrayBuffer());
  const repo = repoSigning(body, req.headers.get("x-hub-signature-256"));
  if (repo === null)
    return new Response("signature does not match any forwarder's secret\n", {
      status: 401,
    });
  const event = req.headers.get("x-github-event");
  if (!isDeliveryEvent(event))
    return new Response(`event ${event ?? "(none)"} is not forwarded\n`, {
      status: 400,
    });
  const json: unknown = JSON.parse(new TextDecoder().decode(body));
  await ingest(repo, event, json);
  return new Response(null, { status: 204 });
}

async function ingest(
  signer: string,
  event: DeliveryEvent,
  json: unknown,
): Promise<void> {
  switch (event) {
    case "ping": {
      const d = DeliverySchemas.ping.parse(json);
      assertSameRepo(signer, d.repository.full_name);
      markConnected(signer);
      // Off the delivery's path: the forwarder waits on this answer.
      void catchUp(runningGh(), signer).catch((err: unknown) =>
        reportCatchUpFailure(signer, err),
      );
      return;
    }
    case "workflow_run": {
      const run = DeliverySchemas.workflow_run.parse(json).workflow_run;
      assertSameRepo(signer, run.repository.full_name);
      const watch = watchFor(signer, run.path);
      if (watch === null) return;
      const stored = await upsertRun(
        runFacts(run, { headIsRunName: watch.headIsRunName === true }),
      );
      if (stored.status !== "completed") return;
      const gh = runningGh();
      await reportIfFailed(stored, failedJobsLoader(gh));
      // An asset upload sends no `release` event: the run that uploads it
      // ending is when the release's assets are re-read.
      if (releasesWatched(signer)) await refreshReleases(gh, signer);
      return;
    }
    case "workflow_job": {
      const d = DeliverySchemas.workflow_job.parse(json);
      assertSameRepo(signer, d.repository.full_name);
      const failed = failedJobOf(d.workflow_job);
      if (failed === null) return;
      await addFailedJob(jobRunKey(signer, d.workflow_job), failed);
      return;
    }
    case "release": {
      const d = DeliverySchemas.release.parse(json);
      assertSameRepo(signer, d.repository.full_name);
      if (!releasesWatched(signer)) return;
      const facts = releaseFacts(signer, d.release);
      if (d.action === "deleted") await deleteRelease(facts.id);
      else await upsertRelease(facts);
      return;
    }
  }
}

/** A forwarder only forwards its own repo's events: anything else is a bug, loudly. */
function assertSameRepo(signer: string, repo: string): void {
  if (repo !== signer)
    throw new Error(
      `[github-events] the ${signer} forwarder delivered an event of ${repo}`,
    );
}

function reportCatchUpFailure(repo: string, err: unknown): void {
  reportServerError({
    message: `[github-events] catching up ${repo} after its forwarder connected failed: ${err instanceof Error ? err.message : String(err)}`,
    ...crashFieldsOf(err, `github-events:catch-up:${repo}`),
  });
}
