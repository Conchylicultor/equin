import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

/**
 * The menu-bar panel, as an app of its own: the page the native helper's panel
 * window loads (`/home/menu-bar?embed=1`).
 *
 * Its own app rather than a pane of Home because a colour scheme belongs to the
 * app owning a document (`<html>.dark` is one class per page), and the panel
 * must follow the OS like the menu-bar panels around it (`colorMode:
 * "system"`) while Home keeps the global setting. Mounted inside Home's path so
 * the helper's URL is the one it always was; the longest base path wins.
 * `listed: false`: nothing inside equin launches it — the native helper does.
 */
export const menuBarApp = defineApp({
  id: "menu-bar",
  name: "Menu bar",
  basePath: "/home/menu-bar",
  icon: symbol("menu"),
  colorMode: "system",
  listed: false,
});
