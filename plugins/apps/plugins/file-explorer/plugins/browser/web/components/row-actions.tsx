import type { ReactNode } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  hostFsArchiveReasonMessage,
  hostFsExtract,
  type HostFsExtractResult,
} from "@plugins/infra/plugins/host-fs/core";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { absolutePath, baseName, type EntryRow } from "../../core";
import { useHomeDir } from "../internal/host-path-source";

const unarchiveIcon = symbol("unarchive");
const checkIcon = symbol("check");
const contentCopyIcon = symbol("content-copy");

/** What an extraction's answer tells the user. */
function extractToast(result: HostFsExtractResult): void {
  switch (result.kind) {
    case "extracted":
      showToast({
        variant: "success",
        description: `Extracted ${baseName(result.created)}`,
      });
      return;
    case "not-an-archive":
      showToast({ variant: "error", description: "Not an archive" });
      return;
    case "missing":
      showToast({
        variant: "error",
        description: "This archive no longer exists",
      });
      return;
    case "denied":
      showToast({ variant: "error", description: "Permission denied" });
      return;
    case "unreadable-archive":
      showToast({
        variant: "error",
        description: hostFsArchiveReasonMessage(result.reason),
      });
      return;
  }
}

/**
 * Extract here: an archive file (a zip) extracted beside itself — its one
 * top-level folder or file as itself, several entries into a new folder named
 * after the archive (host-fs decides, and never overwrites). Every
 * listing is live (pushed from a watch of the folder), so the new entry
 * appears in place. Offered on archive files on disk only.
 */
export function ExtractAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const extract = useEndpointMutation(hostFsExtract);
  if (row.archive === undefined) return null;
  return (
    <IconButton
      icon={unarchiveIcon}
      label="Extract here"
      onClick={async () => {
        extractToast(await extract.mutateAsync({ body: { path: row.path } }));
      }}
    />
  );
}

/**
 * Copy path: the entry's full absolute path (home expanded) to the clipboard,
 * the button's own check-mark flash the feedback. Waits for the home
 * directory, so it never copies the `~/…` display form.
 */
export function CopyPathAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const home = useHomeDir();
  const path = home.kind === "ready" ? absolutePath(row.path, home.home) : null;
  const { copy, copied } = useCopyToClipboard(path ?? "");
  return (
    <IconButton
      icon={copied ? checkIcon : contentCopyIcon}
      label="Copy path"
      tooltip={copied ? "Copied" : "Copy path"}
      disabled={path === null}
      onClick={copy}
    />
  );
}
