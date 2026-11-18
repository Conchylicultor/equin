// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: the binding is
// `bun:ffi` (same as packages/sleep-clock). Never import it from `web/`.
export {
  readThreadCpu,
  readThreadCpuOf,
  threadCpuHandle,
} from "./internal/thread-cpu-clock";
export type {
  ThreadCpuHandle,
  ThreadCpuReading,
} from "./internal/thread-cpu-clock";
