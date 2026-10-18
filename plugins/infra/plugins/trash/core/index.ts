export { trashEntryIdKind } from "./id-kind";
export type { TrashEntryId } from "./id-kind";

export { TrashEntrySchema, TrashOutcomeSchema } from "./schemas";
export type { TrashEntry, TrashOutcome } from "./schemas";

export { listTrash, restoreTrash, purgeTrash } from "./endpoints";

export { trashEntries } from "./resources";
export type { TrashEntryRow } from "./resources";

export { trashEntryFields, trashEntriesEntityRef } from "./entity";
