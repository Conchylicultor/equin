import elarun from "./elarun.jpg";
import shell from "./shell.jpg";
import fold from "./fold.jpg";
import amber from "./amber.jpg";
import opal from "./opal.jpg";
import kokkini from "./kokkini.jpg";

/**
 * Built-in wallpaper id → bundled image URL. Keyed by the ids of
 * `BUILTIN_WALLPAPERS` (core); the gradient has no entry (it is drawn).
 */
const BUILTIN_WALLPAPER_URLS: Record<string, string> = {
  elarun,
  shell,
  fold,
  amber,
  opal,
  kokkini,
};

export function builtinWallpaperUrl(id: string): string | undefined {
  return BUILTIN_WALLPAPER_URLS[id];
}
