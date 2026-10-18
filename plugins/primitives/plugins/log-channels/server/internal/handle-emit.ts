import { implement } from "@plugins/infra/plugins/endpoints/server";
import { emitLogs } from "../../core/endpoints";
import { emitClientLogs } from "./client-ingress";
import { LogPersistence } from "./persistence";

export const handleEmit = implement(emitLogs, ({ body }) => {
  // Backpressure. This is the ONE observability channel whose volume driver is
  // EXTERNAL — a browser that keeps POSTing regardless of host state — so while
  // the box is in trouble the cheapest thing to do is not do the work at all.
  // Refusing here removes the whole request downstream of the parse: the ring
  // pushes, the file write and the WS fan-out, none of which a sink-level gate
  // would touch. One read PER REQUEST, never per line; on the desktop it is the
  // duress latch's `isUnderDuress()`, an in-process memo over at most one
  // statSync per 2 s.
  //
  // The refusal is a typed `paused` result on a 200, never an error status: the
  // browser logs "Failed to load resource" for every non-2xx (so a 429 filled the
  // console for the whole episode), and the endpoint-error reporter files a crash
  // report for every 5xx (so a 503 would set off a report storm during duress).
  //
  // Nothing is lost: the browser re-queues the batch in order and retries (see
  // web/client-log.ts).
  if (LogPersistence.get().clientIngressPaused())
    return { status: "paused", reason: "duress" };
  emitClientLogs(body);
  return { status: "accepted" };
});
