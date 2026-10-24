// Web-safe: the state vocabulary, the live value and the endpoint contracts.
// Declaring, installing and running a dependency is `server/` (and the CLI).
export {
  DEP_LOG_TAIL_LINES,
  DepRowSchema,
  DepStateSchema,
  DepUpdatesSchema,
} from "./internal/dep-state";
export type { DepRow, DepState, DepUpdates } from "./internal/dep-state";
export {
  depsStates,
  installDepEndpoint,
  removeDepEndpoint,
} from "./internal/resources";
