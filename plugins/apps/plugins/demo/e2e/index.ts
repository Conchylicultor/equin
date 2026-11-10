/**
 * e2e barrel for the demo: open the `/demo` page at a location inside the
 * demo and enter it through its gate, importable by another plugin's e2e
 * script as `@plugins/apps/plugins/demo/e2e` — for a script that wants the
 * app on the demo's seeded data rather than the user's own.
 */
export {
  bootDemo,
  demoPath,
  embedRoot,
  RENDER_TIMEOUT_MS,
} from "./internal/demo-pages";
