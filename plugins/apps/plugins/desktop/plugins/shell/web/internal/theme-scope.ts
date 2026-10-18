import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { desktopApp } from "../../core";

/**
 * The desktop's theme scope, `app:desktop`: everything the desktop draws
 * around its windows — wallpaper, shelf, previews, menus, launcher, switcher —
 * sits in a `<Theme name={desktopThemeScope}>` (popups: `PopupTheme`), so it
 * wears the desktop's own theme whatever the focused window's app wears.
 */
export const desktopThemeScope = appThemeScope(desktopApp.id);
