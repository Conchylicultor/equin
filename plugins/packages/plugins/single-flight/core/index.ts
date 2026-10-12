// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it takes kernel flocks
// (`packages/flock`, `bun:ffi`) and spawns a wait child. It lives in `core/` so
// the check runner — a `core`-runtime module — can coalesce per-check work, and
// a CLI command can coalesce whole runs. Never import it from `web/`.
export { singleFlight, tryLead } from "./internal/single-flight";
export type {
  Flight,
  FlightLeader,
  Publish,
  SingleFlightOptions,
} from "./internal/single-flight";
