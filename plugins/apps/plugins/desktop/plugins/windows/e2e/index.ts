/**
 * e2e barrel for the desktop's windows: which windows a surface shows, and the
 * elements one desktop ↔ full screen switch restyles (from Chrome's trace),
 * importable by another plugin's e2e script as
 * `@plugins/apps/plugins/desktop/plugins/windows/e2e`.
 */
export { shownWindowIds } from "./support/shown-window-ids";
export {
  BIG_RECALC,
  styleRecalcs,
  traceSwitch,
} from "./support/styled-elements";
export type { TracedSwitch } from "./support/styled-elements";
