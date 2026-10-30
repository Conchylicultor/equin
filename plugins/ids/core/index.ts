export {
  defineIdKind,
  IdParseError,
  ID_PREFIX_RE,
  ID_SHAPES,
} from "./internal/id-kind";
export type { AnyIdKind, Id, IdKind, IdOf, IdShape } from "./internal/id-kind";
export { inlineBoundary } from "./internal/inline-boundary";
export { detectIds } from "./internal/detect";
export type { DetectedId } from "./internal/detect";
export {
  externalIdField,
  idKindField,
  storedIdSchema,
} from "./internal/id-field";
export { kindLabel, parseKindLabel } from "./internal/kind-label";
export { externalReasonOfDecoder, idKindOfDecoder } from "./internal/id-field";
