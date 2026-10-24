import {
  NO_PROTOTYPE_STATUS,
  PrototypeStatusSchema,
  applyPrototypeStatusChange,
  type PrototypeStatus,
  type PrototypeStatusEdit,
} from "../core";
import { openRecordStore, type RecordStore } from "./record-store";

// The status store: ONE JSON file per prototype, `<prototypes>/_status/<id>.json`
// (`{ "done": true, "pinned": false, "deletedAt": null }`), absent while the
// prototype has no status (neither Done, pinned nor deleted).
// One kind of per-prototype record (`record-store.ts`), like the picks.

/** The status dir's name inside the prototypes data dir. */
export const STATUS_DIR_NAME = "_status";

export type StatusStore = RecordStore<PrototypeStatus, PrototypeStatusEdit>;

/** The status store over a prototypes tree at `root`. */
export function openStatusStore(root: string): StatusStore {
  return openRecordStore(root, {
    dirName: STATUS_DIR_NAME,
    label: "prototype status",
    schema: PrototypeStatusSchema,
    empty: NO_PROTOTYPE_STATUS,
    apply: applyPrototypeStatusChange,
    equal: (a, b) =>
      a.done === b.done && a.pinned === b.pinned && a.deletedAt === b.deletedAt,
  });
}
