import { useLive } from "@plugins/network/plugins/live/web";
import type {
  GateUnavailable,
  ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { editedFiles } from "../core";
import type { EditedFilesPayload } from "../core";

// The payload is a `Resolvable<EditedFile[]>`: consumers narrow on `.resolved`
// (an unresolved worktree renders its `reason`, not a fake empty list).
// A `null` id (no conversation in the route yet) reads nothing and stays
// pending — `useLive(value, null)`. The files are measured from git on disk
// (`needsMachine`), so under a host without the computer the read is
// `unavailable` — its own arm, never an empty list.
export function useEditedFiles(
  conversationId: string | null,
): ResourceResult<EditedFilesPayload> | GateUnavailable {
  return useLive(
    editedFiles,
    conversationId === null ? null : { id: conversationId },
  );
}
