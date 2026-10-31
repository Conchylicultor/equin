import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { useFolderPeekTarget } from "@plugins/apps/plugins/file-explorer/plugins/folder-peek/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const folderIcon = symbol("folder");

/**
 * Pure renderer, reachable ONLY on a claim — `value` is the resolved absolute
 * path of a folder the host's stat found, so there is no "not a folder"
 * branch and no `<code>` fallback here. The chip keeps the text the agent
 * wrote; clicking it browses the folder in a side pane.
 */
export function FolderLinkChip({
  content,
  value,
}: {
  content: string;
  value: string;
}) {
  const folderTarget = useFolderPeekTarget();
  return (
    <LinkChip
      activation={folderTarget(value)}
      leading={<Icon icon={folderIcon} className="text-muted-foreground" />}
      mono
    >
      {content}
    </LinkChip>
  );
}
