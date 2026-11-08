// The on-disk record a `playwright-browser` install leaves in its `env/`, and
// its reader. Plain data + one synchronous read, so host code that cannot
// reach the `deps/` engine barrel (the layout-geometry suite, which lives
// under `web/`) reads an install's executables the same way the kind does.
export {
  BROWSER_EXECUTABLES_FILE,
  BrowserExecutablesSchema,
  readBrowserExecutablesSync,
} from "./internal/executables";
export type {
  BrowserExecutables,
  ReadBrowserExecutables,
} from "./internal/executables";
