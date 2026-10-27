import {
  StoredPicksSchema,
  applyPicksChange,
  type PicksChange,
  type StoredPicks,
} from "../core";
import type { Mount } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import {
  RECORD_FILE_EXT,
  openRecordStore,
  type RecordStore,
} from "./record-store";

// The option-picks store: ONE JSON file per prototype, `<prototypes>/_picks/<id>.json`,
// holding the raw picks — `{ "palette": "azure" }`. Every surface reads and
// writes that one file (main, every worktree deploy, every browser), so the
// variant the user picked is the variant everybody sees, and an agent can read
// it with `./equin prototype options <id>`.
//
// One kind of per-prototype record (`record-store.ts`): the file layout, the
// lock, the atomic write and the malformed-file rule live there.
//
// Design: `research/2026-09-16-global-shared-prototype-option-picks.md`.

/** The picks dir's name inside the prototypes data dir. */
export const PICKS_DIR_NAME = "_picks";

/** A picks file's extension — the one the watcher's extension filter passes. */
export const PICKS_FILE_EXT = RECORD_FILE_EXT;

export type PicksStore = RecordStore<StoredPicks, PicksChange>;

/** The picks store over a prototypes tree. */
export function openPicksStore(mount: Mount): PicksStore {
  return openRecordStore(mount, {
    dirName: PICKS_DIR_NAME,
    label: "prototype picks",
    schema: StoredPicksSchema,
    empty: {},
    apply: applyPicksChange,
    equal: samePicks,
  });
}

/** Same keys, same values — order is not a change (the fold keeps an existing key's place). */
function samePicks(a: StoredPicks, b: StoredPicks): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}
