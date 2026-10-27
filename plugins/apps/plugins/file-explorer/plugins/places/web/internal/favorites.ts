import { displayPath } from "@plugins/infra/plugins/host-account/core";
import { useCallback } from "react";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { DraggedHostPath } from "@plugins/infra/plugins/host-fs/core";
import { useHomeDir } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import {
  baseName,
  parentPath,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import type { PlacesState } from "@plugins/apps/plugins/file-explorer/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { placesConfig } from "../../shared/config";

/** One pinned favorite: its path in display form, and how it opens. */
export interface Pin {
  path: string;
  kind: "dir" | "file";
}

const folderIcon = symbol("folder");
const fileIcon = symbol("description");
const starIcon = symbol("star");

/** The source id of the pinned favorites — its rows are the removable ones. */
export const PINNED_SOURCE = "pinned";

/**
 * The pinned favorites as places: a folder opens itself, a file opens its
 * folder with the file beside it. Pending until the config (boot-preloaded)
 * and the home directory are known — never an empty list standing in.
 */
export function usePinnedPlaces(): PlacesState {
  const config = useConfigResult(placesConfig);
  const home = useHomeDir();
  if (config.status === "error") {
    return {
      kind: "failed",
      label: "Pinned favorites",
      icon: starIcon,
      message: config.error.message,
    };
  }
  if (config.status === "loading" || home.kind === "pending") {
    return { kind: "pending" };
  }
  if (home.kind === "failed" || home.kind === "unavailable") {
    return {
      kind: "failed",
      label: "Pinned favorites",
      icon: starIcon,
      message:
        home.kind === "unavailable"
          ? home.message
          : "The home directory is not known",
    };
  }
  return {
    kind: "ready",
    places: config.data.pinned.map((pin) => {
      const label = baseName(pin.path);
      if (pin.kind === "dir") {
        return { id: pin.path, label, path: pin.path, icon: folderIcon };
      }
      return {
        id: pin.path,
        label,
        path: parentPath(pin.path, home.home) ?? "/",
        open: pin.path,
        icon: fileIcon,
      };
    }),
  };
}

/** The row key of a pinned favorite in the Places sidebar (its source, then
 *  its place id — the pin's path). */
export function pinRowKey(pin: Pin): string {
  return `${PINNED_SOURCE}:${pin.path}`;
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
  unpin: (path: string) => void;
  /** The pins for dropped host paths (absolute, each with the kind the
   *  surface it was dragged from listed — so pinning reads nothing): a
   *  folder pins as one, anything else as a file. */
  pinsOf: (entries: readonly DraggedHostPath[]) => Pin[];
} {
  const config = useConfigResult(placesConfig);
  const setConfig = useSetConfig(placesConfig);
  const home = useHomeDir();
  // A write needs the list as it is: none while it is not known, or unreadable.
  const current = foldResource(config, {
    loading: () => null,
    error: () => null,
    ready: (data) => data.pinned,
  });
  const homeDir = home.kind === "ready" ? home.home : null;

  const known = useCallback(() => {
    if (current === null) {
      throw new Error("file-explorer places: pinned favorites not known yet");
    }
    return current;
  }, [current]);

  const pin = useCallback(
    (pins: readonly Pin[]) => {
      const list = known();
      const have = new Set(list.map((p) => p.path));
      const added: Pin[] = [];
      for (const p of pins) {
        if (have.has(p.path)) continue;
        have.add(p.path);
        added.push(p);
      }
      if (added.length > 0) setConfig("pinned", [...list, ...added]);
    },
    [known, setConfig],
  );

  const unpin = useCallback(
    (path: string) => {
      setConfig(
        "pinned",
        known().filter((p) => p.path !== path),
      );
    },
    [known, setConfig],
  );

  const pinsOf = useCallback(
    (entries: readonly DraggedHostPath[]): Pin[] => {
      if (homeDir === null) {
        throw new Error("file-explorer places: home directory not known yet");
      }
      return entries.map((e) => ({
        path: displayPath(e.path, homeDir),
        kind: e.kind === "dir" ? "dir" : "file",
      }));
    },
    [homeDir],
  );

  return { pin, unpin, pinsOf };
}
