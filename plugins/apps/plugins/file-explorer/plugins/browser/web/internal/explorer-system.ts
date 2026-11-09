import {
  BROWSABLE_FILE_SYSTEMS,
  FILE_SYSTEMS,
  type BrowsableFileSystem,
  type FileSystemCapabilities,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useFileSystems } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import type { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useHomeDir } from "./host-path-source";

/**
 * The file system a browser shows, as it reads its paths: `home` is what `~`
 * stands for in that system (the account's home folder on the computer's
 * disk; `/`, its root, in the browser's storage, whose home IS its root), and
 * `capabilities` the operations it offers controls for.
 */
export interface ExplorerSystem {
  fs: BrowsableFileSystem;
  home: string;
  capabilities: FileSystemCapabilities;
}

export type ExplorerSystemState =
  | { kind: "pending" }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; system: ExplorerSystem };

/** The sentence for a file system this host does not serve. */
function absentMessage(fs: BrowsableFileSystem): string {
  return `${FILE_SYSTEMS[fs].label} has no files here`;
}

/**
 * The file system `fs` as a browser reads it — `unavailable` (with why) when
 * this host does not serve it: the computer's disk in the in-browser demo, the
 * browser's storage on the desktop.
 */
export function useExplorerSystem(
  fs: BrowsableFileSystem,
): ExplorerSystemState {
  const systems = useFileSystems();
  const computerHome = useHomeDir();
  const capabilities = FILE_SYSTEMS[fs].capabilities;
  if (fs === "computer") {
    // The home folder's read is the computer's own (`needsMachine`): its
    // unavailable message is the one every computer read gives.
    switch (computerHome.kind) {
      case "pending":
        return { kind: "pending" };
      case "failed":
        return computerHome;
      case "unavailable":
        return { kind: "unavailable", message: computerHome.message };
      case "ready":
        return {
          kind: "ready",
          system: { fs, home: computerHome.home, capabilities },
        };
    }
  }
  switch (systems.kind) {
    case "pending":
      return { kind: "pending" };
    case "failed":
      return systems;
    case "ready":
      return systems.served.includes(fs)
        ? { kind: "ready", system: { fs, home: "/", capabilities } }
        : { kind: "unavailable", message: absentMessage(fs) };
  }
}

/**
 * The file system whose home Files opens on: the first this host serves
 * (the computer's disk on the desktop, the browser's storage in the demo).
 * `none` on a host serving neither.
 */
export type HomeSystemState =
  | { kind: "pending" }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | { kind: "none" }
  | { kind: "ready"; fs: BrowsableFileSystem };

export function useHomeSystem(): HomeSystemState {
  const systems = useFileSystems();
  switch (systems.kind) {
    case "pending":
    case "failed":
      return systems;
    case "ready": {
      const fs = BROWSABLE_FILE_SYSTEMS.find((s) => systems.served.includes(s));
      return fs === undefined ? { kind: "none" } : { kind: "ready", fs };
    }
  }
}
