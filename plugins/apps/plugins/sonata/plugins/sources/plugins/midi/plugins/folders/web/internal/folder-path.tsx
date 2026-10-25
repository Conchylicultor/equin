import {
  displayPath,
  hostHome,
} from "@plugins/infra/plugins/host-account/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { folderIcon } from "./folder-copy";

/**
 * A folder's path as it is shown: the home directory written `~`. Without the
 * home directory (not known yet, unreadable, or no computer behind the app)
 * the path as configured — the same folder, spelled absolute, never a
 * stand-in: the home directory only shortens it.
 */
export function useShownPath(path: string): string {
  const home = useLive(hostHome);
  return foldResource(home, {
    ready: (dir) => displayPath(path, dir),
    loading: () => path,
    error: () => path,
    unavailable: () => path,
  });
}

/** A folder's path as a quiet mono chip. */
export function FolderPath({ path }: { path: string }) {
  const shown = useShownPath(path);
  return (
    <Inline
      gap="2xs"
      align="center"
      className="max-w-full rounded-md bg-muted py-2xs pr-sm pl-xs text-muted-foreground"
    >
      <Icon icon={folderIcon} className={`size-3 ${rigidClass()}`} />
      <Text variant="code" title={path}>
        {shown}
      </Text>
    </Inline>
  );
}
