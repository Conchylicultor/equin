export {
  recordCreatedSlot,
  getCreatedSlots,
  isSlot,
  collectSlots,
  declaredSlotSources,
  declarePluginSlots,
  subscribeSlotsDeclared,
  findUndeclaredSlots,
  seg,
  slotIdFor,
} from "./declaration";
export type {
  SlotScope,
  SlotNaming,
  SlotNamingEntry,
  SlotLookup,
  SlotHandle,
  SlotSource,
  SlotRecord,
  SlotDeclaration,
  SlotDeclaringPlugin,
  SlotDeclarationListener,
} from "./declaration";
export { KEY_SPACES, isKeySpace } from "./companion-keys";
export type {
  KeySpace,
  KeyedCompanions,
  SlotCompanions,
} from "./companion-keys";
