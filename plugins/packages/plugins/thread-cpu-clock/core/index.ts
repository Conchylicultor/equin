// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: the binding is
// `bun:ffi` (same as packages/sleep-clock). Never import it from `web/`.
export { readThreadCpu } from "./internal/thread-cpu-clock";
export type { ThreadCpuReading } from "./internal/thread-cpu-clock";
