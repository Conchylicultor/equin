import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

/**
 * The menu-bar panel, as an app of its own: the page the native helper's panel
 * window loads (`/home/menu-bar?embed=1`).
 *
 * Its own app rather than a pane of Home because a colour scheme and a theme
 * belong to an app (each app's boundary wears its own): the panel wears the
 * companions' theme (`companion`) and follows the OS scheme
 * (`colorMode: "system"`), as the OS menu around it does, while Home keeps the
 * global setting. Mounted inside Home's path so the helper's URL is the one it
 * always was; the longest base path wins. `listed: false`: nothing inside
 * equin launches it — the native helper does.
 */
export const menuBarApp = defineApp({
  id: "menu-bar",
  name: "Menu bar",
  basePath: "/home/menu-bar",
  icon: symbol("menu"),
  colorMode: "system",
  listed: false,
});
