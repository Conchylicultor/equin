import type { ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  hostFsPathStat,
  MACOS_FILES_AND_FOLDERS_SETTINGS,
} from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const lockIcon = symbol("lock");
const missingIcon = symbol("draft");
const refreshIcon = symbol("refresh");

/**
 * A host file's renderer, unless the file is not there or its contents cannot
 * be read — then why, in place of whatever the renderer would make of the
 * failed read (a player's "No preview", an empty image). Its live
 * `host-fs.stat` says so (refused `missing`, or `read`); until it lands, or
 * with no computer behind the app, the renderer shows as is: it has its own
 * loading and failure states. The stat is watched, so a file that appears (or
 * becomes readable) swaps the renderer in.
 */
export function HostReadGate({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  const stat = useLive(hostFsPathStat, { path });
  switch (stat.status) {
    case "error":
      if (stat.error.kind === "refused" && stat.error.code === "missing")
        return <MissingHostFile path={path} />;
      // Refused otherwise, or failed: the renderer's own read meets the same
      // answer and shows it.
      return children;
    // Not known yet, or no computer: the renderer's own states cover it.
    case "loading":
    case "unavailable":
      return children;
    case "ready": {
      const read = stat.data.read;
      return read === "macos-privacy" || read === "permissions" ? (
        <UnreadableHostFile read={read} recheck={stat.refetch} />
      ) : (
        children
      );
    }
  }
}

/** "File not found", and the path that was looked for. */
function MissingHostFile({ path }: { path: string }) {
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
function UnreadableHostFile({
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
