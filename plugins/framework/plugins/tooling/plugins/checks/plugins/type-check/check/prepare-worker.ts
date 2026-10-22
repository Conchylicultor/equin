// The preparation thread's entry: a Bun Worker spawned by `./prepare-thread`,
// one per type-check run. It holds that run's ONE session (`./prepare`)
// between the two requests, so everything the record phase needs from the
// prepare phase stays in this thread's memory.
//
// Every request gets exactly one reply. A throw becomes an `error` reply
// carrying this thread's stack, so a failure inside `./prepare` surfaces as the
// check's own thrown error — never as a runner waiting on a thread that died
// quietly.

import { openPreparation, type Preparation } from "./prepare";
import type { PrepareReply, PrepareRequest } from "./prepare-thread";

declare var self: Worker;

let session: Preparation | null = null;

async function handle(request: PrepareRequest): Promise<PrepareReply> {
  switch (request.type) {
    case "prepare":
      // One run, one session: a second prepare would silently drop the state
      // the first one's finalize needs.
      if (session) {
        throw new Error("type-check prepare thread: prepare called twice");
      }
      // Mostly SYNCHRONOUS work. `openPreparation` awaits git (the run's tree
      // by its hash, and the ignored entries the overlay comes from) and, when
      // a rule group moved, the lint contributions (`typeAwareLintGroups`);
      // `finalize` awaits the exemption manifests. Neither yields to another
      // request: a second one in flight is refused by the runner side
      // (`./prepare-thread`).
      session = await openPreparation(request.input);
      return { type: "plan", plan: session.plan };
    case "finalize":
      if (!session || !("finalize" in session)) {
        throw new Error(
          "type-check prepare thread: finalize with no run plan to record for",
        );
      }
      return {
        type: "finalized",
        finalized: await session.finalize(request.outcome),
      };
  }
}

self.onmessage = (event: MessageEvent) => {
  // A message handler cannot itself be async (its return value is ignored), so
  // the one reply-per-request contract is kept by an explicit fire-and-forget:
  // `respond` never rejects — it turns every throw into an `error` reply.
  void respond(event.data as PrepareRequest);
};

async function respond(request: PrepareRequest): Promise<void> {
  let reply: PrepareReply;
  try {
    reply = await handle(request);
  } catch (err) {
    // Not swallowed: handed to the runner, which rejects the pending call with
    // it and so fails the check.
    reply =
      err instanceof Error
        ? { type: "error", message: err.message, stack: err.stack }
        : { type: "error", message: String(err), stack: undefined };
  }
  self.postMessage(reply);
}
