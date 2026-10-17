import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  useEndpoint,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { hostFsOpen, hostFsStat } from "@plugins/infra/plugins/host-fs/core";
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
 * Whether the host path `path` lies inside an archive (its stat says so):
 * there is no file on disk to open with a default app. `false` until known.
 */
export function useIsInArchive(path: string): boolean {
  const stat = useEndpoint(hostFsStat, {}, { query: { path } });
  return stat.data?.kind === "ok" && stat.data.within !== undefined;
}

function OpenWithDefaultApp({ path }: { path: string }) {
  const openHostFile = useOpenHostFile();
  const inArchive = useIsInArchive(path);
  if (inArchive) return null;
  return (
    <Button variant="outline" onClick={() => openHostFile(path)}>
      <Icon icon={navIcons.hostApp} />
      Open with default app
    </Button>
  );
}
