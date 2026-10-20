import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  hostFsOpen,
  hostFsPathStat,
} from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { fileTypeOf } from "@plugins/primitives/plugins/file-type/core";
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
import { fileRefName, type FileRef } from "../../core";

/**
 * The file's kind as "No preview for … files" names it: file-type's label
 * ("PNG image", "Disk image"), with an unknown type's "ZIP file" cut to "ZIP"
 * so the sentence does not say "file files".
 */
function kindLabel(name: string): string {
  const label = fileTypeOf(name).label;
  return label === "File" ? "these" : label.replace(/ file$/, "");
}

/**
 * The fallback body for a file no renderer can show: a large file icon, "No
 * preview for <kind> files", and — for a file on the host, which has a default
 * app — an Open with default app button (not for a file inside an archive,
 * which has no file of its own to hand an app). The fallback renderer shows it when
 * no other renderer is offered; the code renderer shows it when a read finds
 * the file binary.
 */
export function NoPreview({ file }: { file: FileRef }) {
  const name = fileRefName(file);
  return (
    <Center axis="both" className="h-full p-lg">
      <Stack direction="col" align="center" gap="md">
        <FileTypeIcon name={name} className="size-12" />
        <Text as="p" variant="body" className="text-muted-foreground">
          No preview for {kindLabel(name)} files
        </Text>
        {file.source === "host" && <OpenWithDefaultApp path={file.path} />}
      </Stack>
    </Center>
  );
}

/**
 * Open a host file with its default app (`reveal` → show it in the Finder),
 * telling the user when the file is gone or unreadable. The one opener every
 * "Open with default app" affordance shares.
 */
export function useOpenHostFile(): (
  path: string,
  opts?: { reveal?: boolean },
) => Promise<void> {
  const { mutateAsync } = useEndpointMutation(hostFsOpen);
  return async (path, opts) => {
    const result = await mutateAsync({
      body: opts?.reveal ? { path, reveal: true } : { path },
    });
    if (result.kind === "missing") {
      showToast({
        title: "File not found",
        description: path,
        variant: "error",
      });
    } else if (result.kind === "denied") {
      showToast({
        title: "Permission denied",
        description: path,
        variant: "error",
      });
    } else if (result.kind === "in-archive") {
      showToast({
        title: "This file is inside an archive",
        description: `Extract ${result.archive} to open it with its default app.`,
        variant: "error",
      });
    }
  };
}

/**
 * Whether a host path is a file on disk a default app can open, or a member of
 * an archive (there is no file to open), as its live `host-fs.stat` says.
 * `loading` until the stat lands — never a guess either way; `unknown` when it
 * was refused, failed, or no computer is behind the app.
 */
export type ArchiveMembership =
  | { kind: "loading" }
  | { kind: "known"; inArchive: boolean }
  | { kind: "unknown"; message: string };

/** {@link ArchiveMembership} of the host path `path`. */
export function useArchiveMembership(path: string): ArchiveMembership {
  const stat = useLive(hostFsPathStat, { path });
  switch (stat.status) {
    case "loading":
      return { kind: "loading" };
    case "unavailable":
      return { kind: "unknown", message: stat.message };
    case "error":
      return { kind: "unknown", message: stat.error.message };
    case "ready":
      return { kind: "known", inArchive: stat.data.within !== undefined };
  }
}

function OpenWithDefaultApp({ path }: { path: string }) {
  const openHostFile = useOpenHostFile();
  const membership = useArchiveMembership(path);
  // Nothing on disk to open (an archive member), or no telling: no button.
  if (membership.kind === "unknown") return null;
  if (membership.kind === "known" && membership.inArchive) return null;
  return (
    <Button
      variant="outline"
      // Not known yet: drawn, but not pressable until the stat lands.
      disabled={membership.kind === "loading"}
      onClick={() => openHostFile(path)}
    >
      <Icon icon={navIcons.hostApp} />
      Open with default app
    </Button>
  );
}
