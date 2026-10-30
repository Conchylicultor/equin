import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import type { FolderStatus } from "../../shared/status";

/** A folder the backend cannot read — every status but `ok`. */
export type UnreadableFolder = Exclude<FolderStatus, { state: "ok" }>;

export const folderIcon = symbol("folder");
const lockIcon = symbol("lock");
const goneIcon = symbol("folder-off");
const warningIcon = symbol("warning");
const waitingIcon = symbol("hourglass-empty");

/** The folder's last path segment — how a sentence names it. */
export function folderName(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  return parts.at(-1) ?? path;
}

/** The glyph a state is drawn with, ok included. */
export function folderStateIcon(status: FolderStatus): IconRef {
  switch (status.state) {
    case "ok":
      return folderIcon;
    case "denied":
      return lockIcon;
    case "missing":
    case "not-a-folder":
      return goneIcon;
    case "unreadable":
      return warningIcon;
    case "checking":
      return waitingIcon;
  }
}

/** Why the folder cannot be read, in a sentence (the notice's body). */
export function unreadableReason(status: UnreadableFolder): string {
  switch (status.state) {
    case "denied":
      return status.code === "EPERM"
        ? "macOS hasn't given equin access to this folder, so the MIDI files in it aren't being imported."
        : "Your user account isn't allowed to read this folder (its permissions keep it out), so the MIDI files in it aren't being imported.";
    case "missing":
      return "Nothing is at this path — the folder was moved or renamed, or it's on a drive that isn't connected.";
    case "not-a-folder":
      return "This path is a file, not a folder, so there is nothing to import from it.";
    case "unreadable":
      return `equin can't read this folder (${status.code}: ${status.message}), so the MIDI files in it aren't being imported.`;
    case "checking":
      return "macOS is asking whether equin may open this folder — answer its dialog (it may be behind other windows). The MIDI files in it are imported once you allow it.";
  }
}

/** The short status a folder row reads under its path. */
export function shortStatus(status: UnreadableFolder): string {
  switch (status.state) {
    case "denied":
      return status.code === "EPERM" ? "No access from macOS" : "No permission";
    case "missing":
      return "Not there";
    case "not-a-folder":
      return "Not a folder";
    case "unreadable":
      return `Can't be read (${status.code})`;
    case "checking":
      return "Waiting for macOS to answer";
  }
}

/**
 * Whether macOS's privacy settings are where access is given back: EPERM is
 * TCC refusing equin (Files & Folders); EACCES is the folder's own Unix
 * permissions, which no System Settings switch changes.
 */
export function deniedByMacOs(status: UnreadableFolder): boolean {
  return status.state === "denied" && status.code === "EPERM";
}

/** What a Check again that changed nothing says. */
export function stillUnreadable(status: UnreadableFolder): string {
  return status.state === "checking"
    ? "macOS still hasn't answered — look for its dialog."
    : status.state === "denied"
    ? "Still no access — checked just now."
    : status.state === "missing"
      ? "Still not there — checked just now."
      : "Still can't be read — checked just now.";
}
