import { useState } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  selfClass,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { FolderPicker } from "@plugins/primitives/plugins/folder-picker/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { MACOS_FILES_AND_FOLDERS_SETTINGS } from "@plugins/infra/plugins/host-fs/core";
import { midiFoldersConfig } from "../../shared/config";
import {
  midiFolderSongCount,
  midiFoldersStatus,
  type FolderStatus,
} from "../../shared/status";
import {
  deniedByMacOs,
  folderName,
  folderStateIcon,
  unreadableReason,
  type UnreadableFolder,
} from "./folder-copy";
import { FolderPath } from "./folder-path";
import { useCheckAgain } from "./use-check-again";

const refreshIcon = symbol("refresh");
// The notice's one primary action reads as the light pill of the approved mock
// (proto-1792907625-p861lr), not the accent: the warning card already carries
// the colour, and an accent button on amber reads as a second alarm.
const PRIMARY_PILL = "bg-foreground text-background hover:bg-foreground/90";

/**
 * The library's notice about watched MIDI folders it cannot read
 * (`Library.Notice`): one row per such folder — which folder, why, and the way
 * out (allow access in macOS, check again, change or remove it). Every other
 * folder keeps importing; this is how the user learns one is not. Nothing
 * while every folder reads, or before the statuses are known (the library
 * below shows its own loading state).
 */
export function MidiFoldersNotice() {
  const statuses = useLive(midiFoldersStatus);
  return foldResource(statuses, {
    loading: () => null,
    error: (error) => (
      <div className="pb-lg">
        <ResourceErrorInline error={error} variant="inline" />
      </div>
    ),
    ready: (all) => {
      const unreadable = all.filter(isUnreadable);
      return unreadable.length === 0 ? null : (
        <FolderNoticeCard folders={unreadable} />
      );
    },
  });
}

export function isUnreadable(status: FolderStatus): status is UnreadableFolder {
  return status.state !== "ok";
}

function FolderNoticeCard({ folders }: { folders: UnreadableFolder[] }) {
  return (
    <div className="pb-lg">
      <Card
        role="status"
        className="rounded-xl border-warning/30 bg-warning/5 p-none shadow-none"
      >
        <ControlSizeProvider size="sm">
          {folders.map((folder) => (
            <FolderNoticeRow key={folder.path} folder={folder} />
          ))}
        </ControlSizeProvider>
      </Card>
    </div>
  );
}

function FolderNoticeRow({ folder }: { folder: UnreadableFolder }) {
  const { folders } = useConfig(midiFoldersConfig);
  const setConfig = useSetConfig(midiFoldersConfig);
  const check = useCheckAgain(folder.path);
  const name = folderName(folder.path);

  const remove = () =>
    setConfig(
      "folders",
      folders.filter((f) => f.path !== folder.path),
    );

  return (
    <Stack
      direction="row"
      gap="md"
      align="center"
      className="border-t border-border px-lg py-md first:border-t-0"
    >
      {/* The tile sits at the top of the row (beside the title), the actions
          stay centred on it. */}
      <Center
        className={cn(
          "size-9 rounded-lg bg-warning/15 text-warning",
          selfClass("start"),
        )}
      >
        <Icon icon={folderStateIcon(folder)} className="size-4.5" />
      </Center>
      <Fill>
        <Stack gap="2xs" align="start">
          <Text variant="heading">
            {folder.state === "denied" ? (
              <>
                Sonata can't open <b>{name}</b>
              </>
            ) : folder.state === "missing" ? (
              <>
                <b>{name}</b> isn't there
              </>
            ) : (
              <>
                Sonata can't read <b>{name}</b>
              </>
            )}
          </Text>
          <FolderPath path={folder.path} />
          <Text
            variant="label"
            tone="muted"
            className="font-normal text-pretty"
          >
            {unreadableReason(folder)} <ImportedStay dir={folder.dir} />
          </Text>
          {check.result !== null ? (
            <Text variant="caption" tone="faint">
              {check.result}
            </Text>
          ) : null}
        </Stack>
      </Fill>
      <Inline gap="xs" align="center" justify="end">
        {deniedByMacOs(folder) ? (
          <>
            <Button
              shape="pill"
              className={PRIMARY_PILL}
              nativeButton={false}
              render={<a href={MACOS_FILES_AND_FOLDERS_SETTINGS} />}
              tooltip={`Opens System Settings → Privacy & Security → Files & Folders, at equin's ${name} switch`}
            >
              Allow access
            </Button>
            <Button shape="pill" variant="secondary" onClick={check.run}>
              <Icon icon={refreshIcon} />
              Check again
            </Button>
          </>
        ) : (
          <>
            <Button shape="pill" className={PRIMARY_PILL} onClick={check.run}>
              <Icon icon={refreshIcon} />
              Check again
            </Button>
            <ChangeFolder path={folder.path} />
          </>
        )}
        <Button
          shape="pill"
          variant="ghost"
          onClick={remove}
          tooltip="Stop watching this folder"
        >
          Remove
        </Button>
      </Inline>
    </Stack>
  );
}

/** "Change folder…": browse to the folder's new place and watch it there. */
function ChangeFolder({ path }: { path: string }) {
  const { folders } = useConfig(midiFoldersConfig);
  const setConfig = useSetConfig(midiFoldersConfig);
  const [open, setOpen] = useState(false);
  return (
    <InlinePopover
      resetOnClose
      open={open}
      onOpenChange={setOpen}
      align="end"
      width="xl"
      padding="none"
      trigger={
        <Button shape="pill" variant="secondary">
          Change folder…
        </Button>
      }
    >
      <FolderPicker
        onSelect={(next) => {
          setConfig(
            "folders",
            folders.map((f) => (f.path === path ? { ...f, path: next } : f)),
          );
          setOpen(false);
        }}
      />
    </InlinePopover>
  );
}

/**
 * "The N songs imported from it stay in your library." — said only once the
 * count is known and non-zero (an empty library has none to keep).
 */
function ImportedStay({ dir }: { dir: string }) {
  const count = useLive(midiFolderSongCount, { dir });
  return foldResource(count, {
    loading: () => null,
    error: (error) => <ResourceErrorInline error={error} variant="inline" />,
    ready: (n) =>
      n === 0 ? null : (
        <>
          {n === 1
            ? "The song imported from it stays in your library."
            : `The ${n} songs imported from it stay in your library.`}
        </>
      ),
  });
}
