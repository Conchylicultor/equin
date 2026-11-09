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
import {
  locationName,
  opensNatively,
  type FileLocation,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";

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
 * Why a renderer that should have shown the file could not — told instead of
 * "No preview for … files", which would claim the kind cannot be previewed
 * when this one file failed. `technical` is the raw reason (a browser's
 * decoder message), shown small and selectable for whoever debugs it.
 */
export interface PreviewFailure {
  title: string;
  detail: string;
  technical?: string;
}

/**
 * The fallback body for a file no renderer can show: a large file icon, "No
 * preview for <kind> files" — or, given a `failure`, what went wrong with this
 * file — and, for a file on the computer's disk, which has a default app, an Open with
 * default app button (not for a file inside an archive, which has no file of
 * its own to hand an app), after a Retry button when `onRetry` is given. The fallback
 * renderer shows it when no other renderer is offered; the code renderer
 * shows it when a read finds the file binary; the media renderer, with a
 * failure, when the player cannot open the file.
 */
export function NoPreview({
  file,
  failure,
  onRetry,
}: {
  file: FileLocation;
  failure?: PreviewFailure;
  onRetry?: () => void;
}) {
  const name = locationName(file);
  return (
    <Center axis="both" className="h-full p-lg">
      <Stack direction="col" align="center" gap="md" className="max-w-md">
        <FileTypeIcon name={name} className="size-12" />
        {failure ? (
          <Stack direction="col" align="center" gap="xs">
            <Text as="p" variant="label">
              {failure.title}
            </Text>
            <Text as="p" variant="body" tone="muted" className="text-center">
              {failure.detail}
            </Text>
            {failure.technical && (
              <Text
                as="p"
                variant="code"
                tone="faint"
                className="text-center break-all select-text"
              >
                {failure.technical}
              </Text>
            )}
          </Stack>
        ) : (
          <Text as="p" variant="body" className="text-muted-foreground">
            No preview for {kindLabel(name)} files
          </Text>
        )}
        <Stack direction="row" align="center" gap="sm">
          {onRetry && (
            <Button variant="outline" onClick={onRetry}>
              Retry
            </Button>
          )}
          {opensNatively(file) && <OpenWithDefaultApp path={file.path} />}
        </Stack>
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
  const open = useEndpointMutation(hostFsOpen);
  return async (path, opts) => {
    // Opening hands the file to the computer's default app: a host without
    // the computer says so instead.
    if (open.kind === "unavailable") {
      showToast({ title: open.message, description: path, variant: "error" });
      return;
    }
    const result = await open.mutateAsync({
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
