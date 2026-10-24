// Shared CLI machinery, not a command (no default export): the `./equin
// build` CLI's build-run recorder. It lives here, not in `server/`, so the CLI
// never reaches the `build_runs` entity — see `shared/recorder.ts`.
export { createBuildRunRecorder } from "./internal/recorder";
export type { BuildRunRecorder } from "../shared/recorder";
