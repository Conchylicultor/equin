import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type {
  AppShellSidebarItem,
  AppShellToolbarItem,
} from "@plugins/primitives/plugins/app-shell/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { BrowsableFileSystem } from "@plugins/infra/plugins/paths/plugins/file-systems/core";

/** Which run of the Places sidebar a place sits in. */
export type PlaceGroup = "favorites" | "locations";

/** What every place has, wherever it leads. */
interface PlaceBase {
  /** Unique within its source; the row's key is `<source id>:<place id>`. */
  id: string;
  label: string;
  icon: IconRef;
}

/**
 * A folder of a file system the routed browser opens. `path` is in display
 * form (`~/…` under that system's home); the sidebar marks it active while the
 * browser shows it.
 */
export interface FolderPlace extends PlaceBase {
  kind: "folder";
  /** The file system it is a folder of. */
  fs: BrowsableFileSystem;
  /** The folder it opens. */
  path: string;
  /**
   * A file it previews in that folder (display form) — a place that is a
   * file opens its folder with the file beside it. Absent for a folder.
   */
  open?: string;
}

/**
 * One place the sidebar lists — always a folder of some file system (an app
 * that wants an entry for its own files points one at its folder).
 */
export type Place = FolderPlace;

/**
 * What a source of places answers. Its places come from the server or a live
 * resource more often than not, so they are `pending` until it answers, and a
 * source that cannot answer is `failed` — still one row, under `label` and
 * `icon`, saying why — never an empty list that looks like "no places".
 *
 * `unavailable`: this host has no such place at all — a folder of a file
 * system this host does not serve (the computer's disk in the in-browser
 * demo), so the sidebar leaves it out rather than listing a place that cannot
 * open.
 */
export type PlacesState =
  | { kind: "pending" }
  | { kind: "ready"; places: readonly Place[] }
  | { kind: "failed"; label: string; icon: IconRef; message: string }
  | { kind: "unavailable" };

/**
 * One source of Places sidebar entries: a single place (Home) and a set of
 * places are the same shape. `usePlaces` resolves them (a
 * hook, so a source may read the server).
 */
export interface PlacesSource {
  /** Unique among sources. */
  id: string;
  group: PlaceGroup;
  usePlaces: Hook<() => PlacesState>;
}

export const FileExplorer = {
  Sidebar: defineRenderSlot<AppShellSidebarItem>({
    docLabel: (p) => p.title,
  }),

  Toolbar: defineRenderSlot<AppShellToolbarItem>({
    docLabel: (p) => ("label" in p ? p.label : undefined),
  }),

  /**
   * The sources of the places the sidebar lists: Home, Downloads, the startup
   * volume, …
   */
  Places: defineSlot<PlacesSource>({
    docLabel: (p) => p.id,
  }),
};
