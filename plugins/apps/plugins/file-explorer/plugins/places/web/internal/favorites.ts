import { displayPath } from "@plugins/infra/plugins/host-account/core";
import { useCallback } from "react";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  isBrowsableFileSystem,
  type BrowsableFileSystem,
  type DraggedFiles,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useFileSystems } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import { useHomeDir } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import {
  baseName,
  parentPath,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import type { PlacesState } from "@plugins/apps/plugins/file-explorer/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { placesConfig } from "../../shared/config";

/** One pinned favorite: its file system, its path in display form, and how it opens. */
export interface Pin {
  fs: BrowsableFileSystem;
  path: string;
  kind: "dir" | "file";
}

const folderIcon = symbol("folder");
const fileIcon = symbol("description");
const starIcon = symbol("star");

/** The source id of the pinned favorites — its rows are the removable ones. */
export const PINNED_SOURCE = "pinned";

/**
 * A pin's place id: its path on the computer's disk (the id every pin had
 * before Files browsed other systems, so a saved row order still finds it),
 * `<fs>:<path>` in another system — a path starts with `~` or `/`, so the two
 * never meet.
 */
export function pinPlaceId(pin: Pick<Pin, "fs" | "path">): string {
  return pin.fs === "computer" ? pin.path : `${pin.fs}:${pin.path}`;
}

/** Whether two pins name the same file (a stored pin's `fs` is the config's string). */
export function samePin(
  a: { fs: string; path: string },
  b: { fs: string; path: string },
): boolean {
  return a.fs === b.fs && a.path === b.path;
}

/** The stored pins as pins — one naming a file system this build does not know is none. */
function pinsIn(
  stored: readonly { fs: string; path: string; kind: string }[],
): Pin[] {
  return stored.flatMap((p) =>
    isBrowsableFileSystem(p.fs)
      ? [{ fs: p.fs, path: p.path, kind: p.kind === "dir" ? "dir" : "file" }]
      : [],
  );
}

/**
 * What `~` is in each served system, once known: the account's home on the
 * computer's disk, the root in the browser's storage. `null` while a served
 * system's home is not known yet.
 */
type Homes = Partial<Record<BrowsableFileSystem, string>>;

function useHomes():
  | { kind: "pending" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; homes: Homes } {
  const systems = useFileSystems();
  const computer = useHomeDir();
  if (systems.kind === "pending") return { kind: "pending" };
  if (systems.kind === "failed") {
    return { kind: "failed", message: systems.error.message };
  }
  const homes: Homes = {};
  if (systems.served.includes("browser")) homes.browser = "/";
  if (systems.served.includes("computer")) {
    switch (computer.kind) {
      case "pending":
        return { kind: "pending" };
      case "failed":
        return { kind: "failed", message: "The home directory is not known" };
      // Served yet unreadable here (no computer behind this transport): its
      // pins have nowhere to open.
      case "unavailable":
        break;
      case "ready":
        homes.computer = computer.home;
    }
  }
  return { kind: "ready", homes };
}

/**
 * The pinned favorites as places: a folder opens itself, a file opens its
 * folder with the file beside it. A pin of a file system this host does not
 * serve is left out (the computer's disk in the demo). Pending until the
 * config (boot-preloaded) and the homes are known — never an empty list
 * standing in.
 */
export function usePinnedPlaces(): PlacesState {
  const config = useConfigResult(placesConfig);
  const homes = useHomes();
  if (config.status === "error") {
    return {
      kind: "failed",
      label: "Pinned favorites",
      icon: starIcon,
      message: config.error.message,
    };
  }
  if (config.status === "loading" || homes.kind === "pending") {
    return { kind: "pending" };
  }
  if (homes.kind === "failed") {
    return {
      kind: "failed",
      label: "Pinned favorites",
      icon: starIcon,
      message: homes.message,
    };
  }
  return {
    kind: "ready",
    places: pinsIn(config.data.pinned).flatMap((pin) => {
      const home = homes.homes[pin.fs];
      if (home === undefined) return [];
      const id = pinPlaceId(pin);
      const label = baseName(pin.path);
      if (pin.kind === "dir") {
        return [
          {
            kind: "folder" as const,
            fs: pin.fs,
            id,
            label,
            path: pin.path,
            icon: folderIcon,
          },
        ];
      }
      return [
        {
          kind: "folder" as const,
          fs: pin.fs,
          id,
          label,
          path: parentPath(pin.path, home) ?? "/",
          open: pin.path,
          icon: fileIcon,
        },
      ];
    }),
  };
}

/** The row key of a pinned favorite in the Places sidebar (its source, then
 *  its place id). */
export function pinRowKey(pin: Pick<Pin, "fs" | "path">): string {
  return `${PINNED_SOURCE}:${pinPlaceId(pin)}`;
}

/**
 * Pin and unpin favorites. A pin already there is not added twice; the list
 * is written whole, read as the config holds it now — so it must be known
 * (it is boot-preloaded: a write before it is would be a bug, and throws).
 * Where a pin shows in the sidebar is the Favorites view's own row order;
 * the list only says what is pinned.
 */
export function useFavorites(): {
  /** Pin at the end; a pin already there stays where it is. */
  pin: (pins: readonly Pin[]) => void;
  unpin: (pin: Pick<Pin, "fs" | "path">) => void;
  /** The pin a place id names, when it is one. */
  pinOf: (placeId: string) => Pin | undefined;
  /** The pins for dropped files (absolute, each with the kind the surface it
   *  was dragged from listed — so pinning reads nothing): a folder pins as
   *  one, anything else as a file. */
  pinsOf: (dropped: DraggedFiles) => Pin[];
} {
  const config = useConfigResult(placesConfig);
  const setConfig = useSetConfig(placesConfig);
  const homes = useHomes();
  // A write needs the list as it is: none while it is not known, or unreadable.
  const current = foldResource(config, {
    loading: () => null,
    error: () => null,
    ready: (data) => data.pinned,
  });
  const known = homes.kind === "ready" ? homes.homes : null;

  const list = useCallback(() => {
    if (current === null) {
      throw new Error("file-explorer places: pinned favorites not known yet");
    }
    return current;
  }, [current]);

  const pin = useCallback(
    (pins: readonly Pin[]) => {
      const have: { fs: string; path: string }[] = [...list()];
      const added: Pin[] = [];
      for (const p of pins) {
        if (have.some((h) => samePin(h, p))) continue;
        have.push(p);
        added.push(p);
      }
      if (added.length > 0) setConfig("pinned", [...list(), ...added]);
    },
    [list, setConfig],
  );

  const unpin = useCallback(
    (pin: Pick<Pin, "fs" | "path">) => {
      setConfig(
        "pinned",
        list().filter((p) => !samePin(p, pin)),
      );
    },
    [list, setConfig],
  );

  const pinOf = useCallback(
    (placeId: string): Pin | undefined =>
      pinsIn(current ?? []).find((p) => pinPlaceId(p) === placeId),
    [current],
  );

  const pinsOf = useCallback(
    (dropped: DraggedFiles): Pin[] => {
      const home = known?.[dropped.fs];
      if (home === undefined) {
        throw new Error(
          `file-explorer places: the ${dropped.fs} file system's home is not known`,
        );
      }
      return dropped.entries.map((e) => ({
        fs: dropped.fs,
        path: displayPath(e.path, home),
        kind: e.kind === "dir" ? "dir" : "file",
      }));
    },
    [known],
  );

  return { pin, unpin, pinOf, pinsOf };
}
