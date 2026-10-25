// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe — it reaches `node:path`
// and `SINGULARITY_DIR`, exactly like `infra/file-sink/core` underneath it. It
// lives in `core/` so the `./equin` CLI (whose runtime isolation gives a
// `core/` file only `core → core`) can write the record and a backend can read
// it back through the SAME declaration. This barrel must NEVER be imported from
// `web/`; the parent plugin's FFI-free `core/` is the web-safe half.

export { SIGNAL_ORIGIN_FILE } from "./internal/lines";
export type {
  ArmFailedLine,
  SignalOriginLine,
  SignalOriginLineInput,
  SignalRecordedLine,
} from "./internal/lines";
export {
  readSignalOriginLines,
  readSignalOriginLinesAsync,
} from "./internal/read";
