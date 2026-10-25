import { useState } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { FolderPickerPopover } from "@plugins/primitives/plugins/folder-picker/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { midiFoldersConfig } from "../../shared/config";
import {
  midiFolderSongCount,
  midiFoldersStatus,
  type FolderStatus,
} from "../../shared/status";
import {
  deniedByMacOs,
  FILES_AND_FOLDERS_SETTINGS,
  folderStateIcon,
  shortStatus,
} from "./folder-copy";
import { isUnreadable } from "./folder-notice";
import { useCheckAgain } from "./use-check-again";

const settingsIcon = symbol("settings");
const removeIcon = symbol("delete");
const midiIcon = symbol("music-note");

/**
 * Sonata's settings, in the library pane's header (`sonataLibraryPane.Actions`):
 * a gear opening a card under it. Its one section is the watched MIDI
 * folders — each with its status (watching N songs, or why it cannot be read
 * with the way out inline), remove, and add with the folder picker. The same
 * `midi-folders` config Settings → Config edits.
 */
export function MidiFoldersSettingsButton() {
  return (
    <ControlPanelPopover
      align="end"
      label="Sonata settings"
      trigger={<IconButton icon={settingsIcon} label="Sonata settings" />}
    >
      <ControlPanel.Section
        needs="described"
        label={
          <Inline gap="xs" align="center">
            <Icon icon={midiIcon} className="size-4 text-muted-foreground" />
            MIDI folders
          </Inline>
        }
        description="MIDI files in these folders join your library and stay in sync as you add, edit or delete them."
      >
        <FolderList />
      </ControlPanel.Section>
    </ControlPanelPopover>
  );
}

function FolderList() {
  const statuses = useLive(midiFoldersStatus);
  const { folders } = useConfig(midiFoldersConfig);
  const setConfig = useSetConfig(midiFoldersConfig);
  // Re-keyed on every add, so the picker starts empty again.
  const [addKey, setAddKey] = useState(0);

  const remove = (path: string) =>
    setConfig(
      "folders",
      folders.filter((f) => f.path !== path),
    );
  const add = (path: string) => {
    const trimmed = path.trim();
    if (trimmed.length === 0) return;
    setAddKey((k) => k + 1);
    if (folders.some((f) => f.path === trimmed)) return;
    setConfig("folders", [...folders, { path: trimmed }]);
  };

  return (
    <Stack gap="xs">
      {foldResource(statuses, {
        loading: () => <Loading variant="rows" count={2} />,
        error: (error) => <ResourceErrorInline error={error} variant="block" />,
        ready: (all) =>
          all.length === 0 ? (
            <Text variant="caption" tone="muted">
              No folders yet.
            </Text>
          ) : (
            // Unreadable folders first: they are why the card is opened.
            [...all]
              .sort((a, b) => Number(isUnreadable(b)) - Number(isUnreadable(a)))
              .map((status) => (
                <FolderRow
                  key={status.path}
                  status={status}
                  onRemove={() => remove(status.path)}
                />
              ))
          ),
      })}
      <FolderPickerPopover
        key={addKey}
        value=""
        onChange={add}
        placeholder="Add a folder — type a path or browse"
      />
    </Stack>
  );
}

function FolderRow({
  status,
  onRemove,
}: {
  status: FolderStatus;
  onRemove: () => void;
}) {
  const bad = isUnreadable(status);
  return (
    <Stack
      direction="row"
      gap="sm"
      align="center"
      className={cn(
        "rounded-lg border py-xs pr-2xs pl-xs",
        bad ? "border-warning/30 bg-warning/5" : "border-border bg-muted/40",
      )}
    >
      <Center
        className={cn(
          "size-7.5 rounded-md",
          bad ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon icon={folderStateIcon(status)} className="size-4" />
      </Center>
      <Fill>
        <Stack gap="none">
          <Text variant="code">{status.path}</Text>
          {status.state === "ok" ? (
            <WatchingCount dir={status.dir} />
          ) : (
            <UnreadableStatus status={status} />
          )}
        </Stack>
      </Fill>
      <IconButton icon={removeIcon} label="Stop watching" onClick={onRemove} />
    </Stack>
  );
}

function UnreadableStatus({
  status,
}: {
  status: Exclude<FolderStatus, { state: "ok" }>;
}) {
  const check = useCheckAgain(status.path);
  return (
    <Stack gap="none">
      <Inline gap="2xs" align="center" wrap>
        <Text variant="caption" className="text-warning">
          {shortStatus(status)}
        </Text>
        {deniedByMacOs(status) ? (
          <>
            <Text variant="caption" tone="faint">
              ·
            </Text>
            <Button
              variant="link"
              nativeButton={false}
              render={<a href={FILES_AND_FOLDERS_SETTINGS} />}
              className="h-auto px-none text-caption text-foreground underline"
            >
              Allow access
            </Button>
          </>
        ) : null}
        {status.state === "not-a-folder" ? null : (
          <>
            <Text variant="caption" tone="faint">
              ·
            </Text>
            <Button
              variant="link"
              onClick={check.run}
              className="h-auto px-none text-caption text-foreground underline"
            >
              Check again
            </Button>
          </>
        )}
      </Inline>
      {check.result !== null ? (
        <Text variant="caption" tone="faint">
          {check.result}
        </Text>
      ) : null}
    </Stack>
  );
}

function WatchingCount({ dir }: { dir: string }) {
  const count = useLive(midiFolderSongCount, { dir });
  return (
    <Inline gap="xs" align="center">
      <span className="size-1.5 rounded-full bg-success" />
      <Text variant="caption" tone="muted">
        Watching
        {foldResource(count, {
          loading: () => null,
          error: () => " · song count unavailable",
          ready: (n) => ` · ${n} ${n === 1 ? "song" : "songs"}`,
        })}
      </Text>
    </Inline>
  );
}
