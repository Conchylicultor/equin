/**
 * e2e barrel for the homepage's live demo: open `/about` at a location inside
 * the demo and enter it, importable by another plugin's e2e script as
 * `@plugins/apps/plugins/website/plugins/landing/plugins/screenshot/e2e` — for
 * a script that wants the app on the demo's seeded data rather than the
 * user's own.
 */
export {
  bootDemo,
  demoPath,
  embedRoot,
  RENDER_TIMEOUT_MS,
} from "./internal/demo-pages";
