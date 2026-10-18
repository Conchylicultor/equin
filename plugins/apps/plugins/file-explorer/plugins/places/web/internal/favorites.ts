import { useCallback } from "react";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { hostFsStat } from "@plugins/infra/plugins/host-fs/core";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { useHomeDir } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import {
  baseName,
  displayPath,
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
  if (home.kind === "failed") {
    return {
      kind: "failed",
      label: "Pinned favorites",
      icon: starIcon,
      message: "The home directory is not known",
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
  /** The pins for host paths (absolute, from a drop): each looked up for
   *  its kind; the ones that are gone or unreadable are left out, and a
   *  toast says which. */
  lookUp: (paths: readonly string[]) => Promise<Pin[]>;
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

  const lookUp = useCallback(
    async (paths: readonly string[]) => {
      if (homeDir === null) {
        throw new Error("file-explorer places: home directory not known yet");
      }
      const looked = await Promise.all(
        paths.map(async (path) => ({
          path,
          stat: await fetchEndpoint(hostFsStat, {}, { query: { path } }),
        })),
      );
      const pins: Pin[] = [];
      const missing: string[] = [];
      for (const { path, stat } of looked) {
        if (stat.kind !== "ok") {
          missing.push(
            `“${baseName(path)}” ${stat.kind === "missing" ? "no longer exists" : "cannot be read"}`,
          );
          continue;
        }
        pins.push({
          path: displayPath(stat.path, homeDir),
          kind: stat.entry.kind === "dir" ? "dir" : "file",
        });
      }
      if (missing.length > 0) {
        showToast({
          variant: "error",
          description: `Not added to Favorites: ${missing.join("; ")}`,
        });
      }
      return pins;
    },
    [homeDir],
  );

  return { pin, unpin, lookUp };
}
