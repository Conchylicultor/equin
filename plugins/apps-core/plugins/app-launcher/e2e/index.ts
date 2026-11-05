/**
 * e2e barrel for the app launcher: open its Apps grid once it is settled, pick
 * a tile and close it again, importable by another plugin's e2e script as
 * `@plugins/apps-core/plugins/app-launcher/e2e`.
 */
export {
  openLauncherGrid,
  closeLauncherGrid,
  launcherTiles,
  pickFromLauncher,
} from "./grid";
