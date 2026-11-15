export { baIdKind } from "./internal/id-kind";
export type { BaId } from "./internal/id-kind";
export {
  BEFORE_AFTER_COLOR_SCHEMES,
  beforeAfterPairAttachmentLinksEntityRef,
  beforeAfterPairFields,
  beforeAfterPairsEntityRef,
} from "./internal/entity";
export type { BeforeAfterColorScheme } from "./internal/entity";
export {
  beforeAfterPairAttachmentLinks,
  beforeAfterPairs,
} from "./internal/live";
export type { BeforeAfterPair } from "./internal/live";
export {
  CAPTURE_LABELS,
  DEFAULT_CAPTURE_VIEWPORT,
  parseRegisterInput,
  REGISTER_BEFORE_AFTER_TOOL,
  RegisterInputError,
  registerBeforeAfterInputShape,
} from "./internal/tool-input";
export type { RegisterBeforeAfterInput } from "./internal/tool-input";
export {
  BEFORE_AFTER_ARTIFACT_KIND,
  extractBeforeAfterHits,
} from "./internal/extract";
