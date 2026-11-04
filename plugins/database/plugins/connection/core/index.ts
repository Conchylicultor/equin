export {
  DB_POOL_NAMES,
  DB_CALL_PHASES,
  DB_TX_STATES,
  IN_FLIGHT_REPORT_MAX,
  isInTransaction,
  DB_POOLS_THROUGH_PGBOUNCER,
  dbApplicationName,
  isDbApplicationName,
  type DbPoolName,
  type DbCallPhase,
  type DbTxState,
} from "./internal/names";
// A connect refused because the server side is full (pgbouncer's
// max_client_conn, Postgres's too_many_connections): back-pressure, transient.
export { isConnectionCapacityRefusal } from "./internal/capacity-refusal";
// A statement names its caller in its own text — `/* origin=<label> */ ` in
// front — so the database side can say who holds a lock (`pg_stat_activity`).
export {
  ORIGIN_LABEL_MAX,
  originCommentLabel,
  parseSqlOrigin,
  tagSqlWithOrigin,
  type SqlOrigin,
} from "./internal/origin-comment";
