// Pure, web-safe: the alignment record (contract 2), the aligner, the aligned
// Score builder and the endpoint contracts. The job, table and live resource
// are `server/`.
export {
  ALIGNER_VERSION,
  AlignmentRecordSchema,
  AlignmentSegmentSchema,
  WEAK_MATCH_THRESHOLD,
  sheetHash,
} from "./internal/record";
export type { AlignmentSegment } from "./internal/record";

// The aligner (sheet × beat features → record) and the record → Score builder
// the UG compile() applies when the record `fitsSheet`.
export { alignChords } from "./internal/align";
export { alignedScore, fitsSheet } from "./internal/aligned-score";
export { MAX_TRIES_PER_RUN } from "./internal/accept";

// The UG source's raw ({ tab, alignment }), the side-table row and the endpoint
// contracts — the integration surface the UG source and the alignment
// server / web halves share.
export { appliedAlignment, UgSourceRawSchema } from "./internal/source-raw";
export type { UgSourceRaw } from "./internal/source-raw";
export {
  AlignmentPhaseSchema,
  AlignmentStatusSchema,
  UgAlignmentRowSchema,
  ugAlignmentShape,
} from "./internal/row";
export type {
  AlignmentCandidate,
  AlignmentPhase,
  AlignmentStatus,
  CandidateOutcome,
  UgAlignmentRow,
  VideoPick,
} from "./internal/row";
export { ugAlignmentRows } from "./internal/resources";
export {
  cancelUgAlignment,
  realignUg,
  refuseUgAlignmentVideo,
  resolveUgAlignment,
  setUgAlignmentVideo,
} from "./internal/endpoints";
