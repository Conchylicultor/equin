// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: the binding is
// `bun:ffi` (same as packages/thread-cpu-clock). Never import it from `web/`.
export { readProcRusage } from "./internal/proc-rusage";
export type { ProcRusage } from "./internal/proc-rusage";
