export {
  FileLocationSchema,
  locationKey,
  locationName,
  opensNatively,
  sameLocation,
} from "./internal/location";
export type { FileLocation, FileSystemKind } from "./internal/location";
export { contentTypeOf } from "./internal/content-type";
export {
  FILE_BYTES_MAX,
  FILE_TEXT_MAX_BYTES,
  FileEntrySchema,
  FileReadAccessSchema,
  FileStatSchema,
  FileTextSchema,
  browserFileBytes,
  browserFileRaw,
  browserFileStat,
  browserFileText,
  checkoutFileBytes,
  checkoutFileRaw,
  checkoutFileText,
  computerFileBytes,
  computerFileRaw,
  computerFileStat,
  computerFileText,
  fileUrl,
} from "./internal/reads";
export type {
  FileEntry,
  FileReadAccess,
  FileStat,
  FileText,
} from "./internal/reads";
