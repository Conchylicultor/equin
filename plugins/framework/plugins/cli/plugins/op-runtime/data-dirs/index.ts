import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The agent-build duress gate: `gate.lock` (a readers/writer flock — every agent
 * build admitted while the host is calm holds it shared, one admitted under
 * duress holds it exclusive) and `line/`, the first-come-first-served line of
 * builds waiting for the exclusive lock.
 *
 * Host-global: the gate is "at most one agent build on this machine while it is
 * in trouble", across every checkout.
 */
export const agentBuildGateDir = defineDataDir({
  kind: "locks",
  name: "agent-build-gate",
  owner: "framework/cli/op-runtime",
  description:
    "The agent-build duress gate: gate.lock (shared while calm, exclusive under duress — one agent build at a time) and the FIFO line of builds waiting for it",
  // Flocks die with their holders, so the files carry no state once nothing is
  // running; deleting them while a build holds the gate would let a second
  // build in beside it.
  reclaim: { kind: "restart" },
});

export default [agentBuildGateDir];
