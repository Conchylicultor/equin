import type { WallpaperAttribution } from "./config";

/** One wallpaper that ships with the app — no server store, no upload. */
export interface BuiltinWallpaper {
  id: string;
  title: string;
  /** Absent for the theme-following gradient, which is drawn, not a picture. */
  attribution?: Required<
    Pick<WallpaperAttribution, "creator" | "license" | "sourceUrl">
  > & {
    /** The collection it comes from ("KDE Plasma", "GNOME Backgrounds"). */
    source: string;
  };
}

const KDE =
  "https://invent.kde.org/plasma/plasma-workspace-wallpapers/-/tree/master";
const GNOME = "https://gitlab.gnome.org/GNOME/gnome-backgrounds";

/**
 * The built-in wallpaper catalog, as data (the credits are the desktop mockup's
 * CREDITS table). `elarun` is the default (see `wallpaperConfig`). The images
 * live in the web folder (`BUILTIN_WALLPAPER_URLS`); the credit text is core so
 * any runtime can name a wallpaper's license.
 */
export const BUILTIN_WALLPAPERS: readonly BuiltinWallpaper[] = [
  {
    id: "elarun",
    title: "Elarun",
    attribution: {
      creator: "Nuno Pinheiro",
      source: "KDE Plasma",
      sourceUrl: `${KDE}/Elarun`,
      license: "LGPLv3",
    },
  },
  {
    id: "shell",
    title: "Shell",
    attribution: {
      creator: "Lucas Andrade",
      source: "KDE Plasma",
      sourceUrl: `${KDE}/Shell`,
      license: "CC BY-SA 4.0",
    },
  },
  {
    id: "fold",
    title: "Fold",
    attribution: {
      creator: "GNOME Design Team",
      source: "GNOME Backgrounds",
      sourceUrl: GNOME,
      license: "CC BY-SA 3.0",
    },
  },
  {
    id: "amber",
    title: "Amber",
    attribution: {
      creator: "GNOME Design Team",
      source: "GNOME Backgrounds",
      sourceUrl: GNOME,
      license: "CC BY-SA 3.0",
    },
  },
  {
    id: "opal",
    title: "Opal",
    attribution: {
      creator: "Ken Vermette",
      source: "KDE Plasma",
      sourceUrl: `${KDE}/Opal`,
      license: "LGPLv3",
    },
  },
  {
    id: "kokkini",
    title: "Kokkini",
    attribution: {
      creator: "Ken Vermette",
      source: "KDE Plasma",
      sourceUrl: `${KDE}/Kokkini`,
      license: "LGPLv3",
    },
  },
  { id: "gradient", title: "Gradient" },
];

/** The id of the gradient entry: follows the theme instead of showing a picture. */
export const GRADIENT_WALLPAPER_ID = "gradient";

/** The wallpaper a fresh desktop shows, and what "Reset to default" returns to. */
export const DEFAULT_WALLPAPER_ID = "elarun";

/** Whether a wallpaper state is already the default (nothing to reset). */
export function isDefaultWallpaper(state: {
  kind: string;
  id: string;
}): boolean {
  return state.kind === "builtin" && state.id === DEFAULT_WALLPAPER_ID;
}

export function getBuiltinWallpaper(id: string): BuiltinWallpaper | undefined {
  return BUILTIN_WALLPAPERS.find((w) => w.id === id);
}
