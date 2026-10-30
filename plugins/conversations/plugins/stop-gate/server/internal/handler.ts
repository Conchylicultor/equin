import { implement } from "@plugins/infra/plugins/endpoints/server";
import { stopGate } from "../../core";
import { evaluateStop } from "./decide";
import { StopGate, StopWaiver } from "./registry";

/** Whether the conversation's agent may end its turn, from every contribution. */
export const handleStopGate = implement(stopGate, ({ params }) =>
  evaluateStop(
    params.id,
    StopGate.getContributions(),
    StopWaiver.getContributions(),
  ),
);
