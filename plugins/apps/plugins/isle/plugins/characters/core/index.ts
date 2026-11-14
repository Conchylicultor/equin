export { LOOKS, LOOK_NAMES, isLookName } from "./internal/looks";
export type { HairStyle, Look, LookName } from "./internal/looks";
export {
  CHARACTER_BOX,
  IDLE_FRAMES,
  STRIDE,
  TURN_SECONDS,
  WALK_FRAMES,
  characterFrame,
  createTurnTracker,
  poseKey,
  viewOf,
} from "./internal/frame";
export type {
  CharacterFrame,
  CharacterLayer,
  CharacterPose,
  CharacterState,
  CharacterView,
  TurnMemory,
  ViewFlip,
} from "./internal/frame";
export { paintCharacterPose, paintCharacterShadow } from "./internal/paint";
