import { absolutePath } from "@plugins/infra/plugins/host-account/core";
import type { ReactNode } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  archiveReasonMessage,
  computerFileExtract,
  type FileExtractResult,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { baseName, type EntryRow } from "../../core";
import { useHomeDir } from "../internal/host-path-source";

const unarchiveIcon = symbol("unarchive");
const checkIcon = symbol("check");
const contentCopyIcon = symbol("content-copy");

/** What an extraction's answer tells the user. */
function extractToast(result: FileExtractResult): void {
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
        description: archiveReasonMessage(result.reason),
      });
      return;
  }
}

/**
 * Extract here: an archive file (a zip) extracted beside itself — its one
 * top-level folder or file as itself, several entries into a new folder named
 * after the archive (the computer's disk decides, and never overwrites).
 * Every listing is live (pushed from a watch of the folder), so the new entry
 * appears in place. Offered on archive files of a system with archives (the
 * computer's disk) only.
 */
export function ExtractAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const extract = useEndpointMutation(computerFileExtract);
  // Extracting writes beside the archive on the computer's disk: with no
  // computer behind the app there is no action to offer.
  if (
    row.fs !== "computer" ||
    row.archive === undefined ||
    extract.kind === "unavailable"
  )
    return null;
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
 * Copy path: the entry's full path to the clipboard, the button's own
 * check-mark flash the feedback. On the computer's disk the absolute path
 * (home expanded) — it waits for the home directory, so it never copies the
 * `~/…` display form; in another system (the browser's storage, whose home
 * names nothing outside it) the path as shown.
 */
export function CopyPathAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const home = useHomeDir();
  const path =
    row.fs !== "computer"
      ? row.path
      : home.kind === "ready"
        ? absolutePath(row.path, home.home)
        : null;
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
