import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
  type ResourceUnavailable,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  resolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";
import {
  EDITED_FILES_MAX,
  editedFile,
  editedFiles,
  type EditedFile,
  type EditedFilesSummary,
} from "../core";

/** A conversation's edited files, as a reader without a viewport holds them. */
export interface EditedFilesRead {
  /** The files, by path — the whole set, or its first `EDITED_FILES_MAX`. */
  files: EditedFile[];
  /** The WHOLE set's totals, whatever `files` holds. */
  summary: EditedFilesSummary;
  /** `files` is the whole set — false when it was cut at `EDITED_FILES_MAX`. */
  complete: boolean;
}

// The edited files, read as pages by path up to `EDITED_FILES_MAX` (bounded:
// past it `complete` is false and `summary.count` says how many there are),
// joined with the meta that says whether the worktree could be measured at all.
// The result is a `Resolvable`: consumers narrow on `.resolved` (an unresolved
// worktree renders its `reason`, not a fake empty list). A `null` id (no
// conversation in the route yet) reads nothing and stays pending. The files are
// measured from git on disk (`needsMachine`), so under a host without the
// computer the read is `unavailable` — its own arm, never an empty list.
export function useEditedFiles(
  conversationId: string | null,
): ResourceResult<Resolvable<EditedFilesRead>> | ResourceUnavailable {
  const query = conversationId === null ? null : { id: conversationId };
  const pages = useLive(editedFiles, query, { limit: EDITED_FILES_MAX });
  const meta = useLive(editedFiles.meta, query);
  return useMemo(
    () =>
      mapResource(
        combineResources({ pages, meta }),
        (data): Resolvable<EditedFilesRead> => {
          if (!data.meta.resolved) return data.meta;
          const summary = data.meta.value;
          return resolved({
            files: data.pages,
            summary,
            complete: data.pages.length >= summary.count,
          });
        },
      ),
    [pages, meta],
  );
}

// One edited file by path — `null` when the path is clean — wherever in the
// set it falls; an unresolved worktree is `{ resolved: false }`. A `null`
// conversation reads nothing.
export function useEditedFile(
  conversationId: string | null,
  path: string,
): ResourceResult<Resolvable<EditedFile | null>> | ResourceUnavailable {
  return useLive(
    editedFile,
    conversationId === null ? null : { id: conversationId, path },
  );
}
