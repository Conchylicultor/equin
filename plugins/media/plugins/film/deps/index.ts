// The film engine's recorded sounds, installed on demand. Host-only, like
// every `deps/` barrel; collected into infra/deps' registry through the
// `default` array.
import { mouseSounds } from "./internal/mouse-sounds";

export {
  mouseSounds,
  mouseSoundFiles,
  resolveMouseSounds,
} from "./internal/mouse-sounds";

export default [mouseSounds];
