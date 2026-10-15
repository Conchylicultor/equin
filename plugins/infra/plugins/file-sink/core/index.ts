// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: this barrel reaches
// `node:fs` / `node:path`. It lives in `core/` so the CLI runtime (whose
// `core → core` isolation put `server/` out of reach) can hit the sanctioned
// bounded-append chokepoint instead of hand-rolling one. This plugin must NEVER
// be imported from `web/`.

export type { FileSink, FileSinkSpec, RotateBound } from "./internal/types";
export {
  defineFileSink,
  getFileSinks,
  openDynamicSink,
  sanitizeChannel,
} from "./internal/file-sink";
export { readTail, readJsonlTail } from "./internal/read";
export type { TailOptions, TailResult, JsonlTailResult } from "./internal/read";
