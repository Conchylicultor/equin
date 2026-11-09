import type { ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { MACOS_FILES_AND_FOLDERS_SETTINGS } from "@plugins/infra/plugins/host-fs/core";
import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useFileStat } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const lockIcon = symbol("lock");
const missingIcon = symbol("draft");
const refreshIcon = symbol("refresh");

/**
 * A file's renderer, unless the file is not there or its contents cannot be
 * read — then why, in place of whatever the renderer would make of the failed
 * read (a player's "No preview", an empty image). Its live stat says so
 * (`missing`, or its `read` access); until it lands, or where nothing
 * describes the file (no computer behind the app, a checkout), the renderer
 * shows as is: it has its own loading and failure states. The stat is
 * watched, so a file that appears (or becomes readable) swaps the renderer in.
 */
export function ReadGate({
  file,
  children,
}: {
  file: FileLocation;
  children: ReactNode;
}) {
  const stat = useFileStat(file);
  switch (stat.kind) {
    case "missing":
      return <MissingFile path={file.path} />;
    // Refused otherwise or failed — the renderer's own read meets the same
    // answer and shows it — or not known yet, or nothing describes it.
    case "failed":
    case "loading":
    case "undescribed":
      return children;
    case "ready": {
      const read = stat.stat.read;
      return read === "macos-privacy" || read === "permissions" ? (
        <UnreadableFile read={read} recheck={stat.recheck} />
      ) : (
        children
      );
    }
  }
}

/** "File not found", and the path that was looked for. */
function MissingFile({ path }: { path: string }) {
  return (
    <Center axis="both" className="h-full p-lg">
      <Stack direction="col" align="center" gap="md" className="max-w-md">
        <Icon icon={missingIcon} className="size-12 text-muted-foreground" />
        <Text as="p" variant="body" className="text-center">
          File not found
        </Text>
        <Text
          as="p"
          variant="caption"
          tone="faint"
          className="text-center break-all"
        >
          Nothing is at {path} — it may have been moved, renamed or deleted.
        </Text>
      </Stack>
    </Center>
  );
}

/**
 * "equin can't read this file", and why: macOS privacy protection (a folder
 * like ~/Downloads the equin app is not allowed into — Allow access opens its
 * switch in System Settings) or the file's own permissions. Check again
 * re-reads the stat: granting access changes no file, so no watch would.
 */
function UnreadableFile({
  read,
  recheck,
}: {
  read: "macos-privacy" | "permissions";
  recheck: () => Promise<void>;
}) {
  return (
    <Center axis="both" className="h-full p-lg">
      <Stack direction="col" align="center" gap="md" className="max-w-md">
        <Icon icon={lockIcon} className="size-12 text-muted-foreground" />
        <Text as="p" variant="body" className="text-center">
          equin can't read this file
        </Text>
        <Text
          as="p"
          variant="caption"
          tone="faint"
          className="text-center text-pretty"
        >
          {read === "macos-privacy"
            ? "macOS hasn't given equin access to the folder it is in. Turn on equin's switch for that folder in System Settings → Privacy & Security → Files & Folders, then check again."
            : "Your user account isn't allowed to read this file (its permissions keep it out)."}
        </Text>
        <Inline gap="xs" align="center" justify="center">
          {read === "macos-privacy" && (
            <Button
              nativeButton={false}
              render={<a href={MACOS_FILES_AND_FOLDERS_SETTINGS} />}
              tooltip="Opens System Settings → Privacy & Security → Files & Folders"
            >
              Allow access
            </Button>
          )}
          <Button variant="outline" onClick={recheck}>
            <Icon icon={refreshIcon} />
            Check again
          </Button>
        </Inline>
      </Stack>
    </Center>
  );
}
