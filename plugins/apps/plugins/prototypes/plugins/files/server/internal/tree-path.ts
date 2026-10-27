import {
  splitRel,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { protoIdKind } from "../../core";
import { PICKS_DIR_NAME } from "../../shared/picks";
import { RECORD_FILE_EXT } from "../../shared/record-store";
import { isRetiredDirName } from "../../shared/retired";
import { HISTORY_DIR_NAME, LATEST_STAMP_FILE } from "./history-store";

/**
 * What a path the tree's watch reported is, as far as the tree's consumers
 * care:
 *
 * - `version-recorded` — `_history/<id>.<format>/latest.json`: a version of
 *   `id` was just recorded, by this backend or any other, in whichever format
 *   the host keeps (`git`, `snapshots`). Re-reads that one history; the
 *   prototype's bytes did not move, so nothing reloads.
 * - `history-internal` — anything else under `_history/` (a staging repo, a
 *   lock): nothing to react to.
 * - `picks-recorded` — `_picks/<id>.json`: `id`'s option picks changed, by
 *   this backend or any other. Re-reads that one record; nothing reloads on
 *   its account (the frames' `src` carries the picks, so they follow).
 * - `picks-internal` — anything else under `_picks/`: nothing to react to.
 * - `retired` — anything under a retired dir (`_trash/`,
 *   `shared/retired.ts`): nothing to react to.
 * - `tree` — everything else: a prototype's own files, `_template/`. Goes
 *   through the signature gate like before.
 */
export type TreePath =
  | { kind: "version-recorded"; id: string }
  | { kind: "history-internal" }
  | { kind: "picks-recorded"; id: string }
  | { kind: "picks-internal" }
  | { kind: "retired" }
  | { kind: "tree" };

export function classifyTreePath(path: RelPath): TreePath {
  const segments = splitRel(path);
  if (segments[0] === HISTORY_DIR_NAME) return classifyHistory(segments);
  if (segments[0] === PICKS_DIR_NAME) {
    const id = recordId(segments);
    return id === null
      ? { kind: "picks-internal" }
      : { kind: "picks-recorded", id };
  }
  if (isRetiredDirName(segments[0])) return { kind: "retired" };
  return { kind: "tree" };
}

function classifyHistory(segments: readonly string[]): TreePath {
  const [, dir, file] = segments;
  // `<id>.<format>`: a minted id has no `.`, so the first one ends it.
  const dot = dir?.indexOf(".") ?? -1;
  const id = dir !== undefined && dot > 0 ? dir.slice(0, dot) : "";
  if (
    segments.length === 3 &&
    file === LATEST_STAMP_FILE &&
    protoIdKind.is(id)
  ) {
    return { kind: "version-recorded", id };
  }
  return { kind: "history-internal" };
}

/** The prototype id a `_<kind>/<id>.json` record path names, or `null` for anything else in the dir. */
function recordId(segments: readonly string[]): string | null {
  const [, file] = segments;
  const id = file?.endsWith(RECORD_FILE_EXT)
    ? file.slice(0, -RECORD_FILE_EXT.length)
    : "";
  return segments.length === 2 && protoIdKind.is(id) ? id : null;
}
