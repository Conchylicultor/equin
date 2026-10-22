import { liveValue } from "@plugins/network/plugins/live/core";
import { CommitsGraphPayloadSchema } from "./protocol";

// The commit rows of one attempt's branch against `main`. The payload is a
// `Resolvable<CommitsGraph>`: an attempt whose worktree is gone is a settled
// `{ resolved: false, reason }`. Not loaded yet is `pending`.
export const commitsGraph = liveValue("commits-graph.graph", {
  schema: CommitsGraphPayloadSchema,
  params: ["attemptId"],
  // Read with git from the attempt's checkout.
  needsMachine: { feature: "Reading an agent's commits" },
});
