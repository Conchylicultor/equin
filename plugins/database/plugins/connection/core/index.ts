export {
  DB_POOL_NAMES,
  DB_CALL_PHASES,
  DB_TX_STATES,
  IN_FLIGHT_REPORT_MAX,
  isInTransaction,
  type DbPoolName,
  type DbCallPhase,
  type DbTxState,
} from "./internal/names";
// A connect refused because the server side is full (pgbouncer's
// max_client_conn, Postgres's too_many_connections): back-pressure, transient.
export { isConnectionCapacityRefusal } from "./internal/capacity-refusal";
