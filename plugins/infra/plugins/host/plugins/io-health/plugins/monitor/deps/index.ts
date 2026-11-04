// The monitor's binary, collected into infra/deps' registry through the
// `default` array (`./equin deps install fs-latency-monitor`); the login
// service runs it from the equin app bundle.
import { fsLatencyMonitorBinary } from "./internal/monitor-binary";

export { fsLatencyMonitorBinary } from "./internal/monitor-binary";

export default [fsLatencyMonitorBinary];
