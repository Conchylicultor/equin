export {
  HOST_IDLE_STATES,
  IDLE_SUSTAIN_MS,
  nextIdleState,
} from "./internal/next-state";
export type {
  BlockerReading,
  HostIdleRecord,
  HostIdleState,
  IdleBlockerReading,
  IdleStep,
} from "./internal/next-state";
export {
  HOST_IDLE_STATE_ID,
  hostIdle,
  HostIdleSchema,
  hostIdleStateEntityRef,
  hostIdleStateFields,
  IdleBlockerStatusSchema,
  MAX_IDLE_BLOCKERS,
} from "./internal/resources";
export type { HostIdle, IdleBlockerStatus } from "./internal/resources";
