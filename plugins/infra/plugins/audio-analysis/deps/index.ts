// audio-analysis's dependency: the `audio-python` env, collected into
// infra/deps' registry through the `default` array (Settings → Dependencies,
// `./equin deps install audio-python`).
import { audioPythonDep } from "./internal/audio-python";

export { audioPythonDep } from "./internal/audio-python";

export default [audioPythonDep];
