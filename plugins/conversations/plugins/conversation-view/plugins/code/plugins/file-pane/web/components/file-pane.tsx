import type { EditedFileStatus } from "@plugins/conversations/plugins/conversation-view/plugins/code/core";
import { FileView } from "@plugins/primitives/plugins/file-viewer/web";

/**
 * A checkout file with its renderer tabs — `primitives/file-viewer`'s
 * `FileView` over a checkout file, with the edited-file status as the context
 * that offers the Diff tab.
 */
export function FilePaneView({
  worktree,
  path,
  status,
  line,
}: {
  worktree: string;
  path: string;
  status: EditedFileStatus;
  line?: number;
}) {
  return (
    <FileView
      file={{ fs: "checkout", checkout: worktree, path }}
      git={{ checkout: worktree, path, status }}
      line={line}
    />
  );
}
