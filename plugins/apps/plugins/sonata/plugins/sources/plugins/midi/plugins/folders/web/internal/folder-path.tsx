import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { folderIcon } from "./folder-copy";

/** A folder's path as a quiet mono chip. */
export function FolderPath({ path }: { path: string }) {
  return (
    <Inline
      gap="2xs"
      align="center"
      className="max-w-full rounded-md bg-muted px-xs text-muted-foreground"
    >
      <Icon icon={folderIcon} className={`size-3 ${rigidClass()}`} />
      <Text variant="code">{path}</Text>
    </Inline>
  );
}
