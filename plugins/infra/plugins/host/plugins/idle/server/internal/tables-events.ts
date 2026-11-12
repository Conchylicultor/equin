import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";

export interface HostIdleTransitionPayload {
  /** When the evaluation that saw the transition ran (ISO). */
  at: string;
  [key: string]: unknown;
}

// The host just became idle: every blocker has been quiet for
// IDLE_SUSTAIN_MS. Emitted once per idle period, by main's evaluation only. No
// filter columns: subscribers re-read the state.
export const { event: hostIdleBegan, table: _hostIdleBeganTriggers } =
  defineTriggerEvent<HostIdleTransitionPayload>({
    name: "host.idleBegan",
    filters: {},
  });

// The host stopped being idle: some blocker is busy again. Work started on
// idle time yields now.
export const { event: hostIdleEnded, table: _hostIdleEndedTriggers } =
  defineTriggerEvent<HostIdleTransitionPayload>({
    name: "host.idleEnded",
    filters: {},
  });
