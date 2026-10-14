// The transcription plugin's dependency: the `sonata-transcription` env (the
// `st` toolkit's libraries), collected into infra/deps' registry through the
// `default` array (Settings → Dependencies, `./singularity deps install
// sonata-transcription`).
import { transcriptionDep } from "./internal/transcription";

export { transcriptionDep } from "./internal/transcription";

export default [transcriptionDep];
