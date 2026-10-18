// A leaf on purpose: zod only. The build CLI's admission valve reads the watcher
// status through this plugin, so nothing here may pull config, DB or a backend
// runtime (enforced by the sentinel:status-file-lean check).
export {
  SentinelDownStatusSchema,
  SentinelStatusRecordSchema,
  SentinelStatusSchema,
  SentinelWatchSchema,
} from "./internal/status";
export type {
  SentinelStatus,
  SentinelStatusRecord,
  SentinelWatch,
} from "./internal/status";
export { duressGuard } from "./internal/duress-guard";
export type { DuressGuard } from "./internal/duress-guard";
export {
  SentinelVitalsRecordSchema,
  SIGNAL_KEYS,
  SignalKeySchema,
  SignalVitalSchema,
} from "./internal/vitals";
export type {
  SentinelVitalsRecord,
  SignalKey,
  SignalVital,
} from "./internal/vitals";
export {
  bytesText,
  DiskAlarmSchema,
  diskAlarmOf,
  DiskReadingSchema,
} from "./internal/disk";
export type { DiskAlarm, DiskReading } from "./internal/disk";
