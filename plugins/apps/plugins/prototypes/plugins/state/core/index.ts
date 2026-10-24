export {
  prototypeTagIdKind,
  prototypeTags,
  prototypeTagsEntityRef,
  prototypeTagTree,
} from "./internal/tags";
export {
  deletePrototype,
  NO_PROTOTYPE_STATE,
  PrototypeStateChangeSchema,
  prototypeStateEntityRef,
  prototypeStateFields,
  prototypeStates,
  restorePrototype,
  setPrototypeState,
} from "./internal/state";
export type { PrototypeState, PrototypeStateChange } from "./internal/state";
