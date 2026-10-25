import {
  registeringPlugin,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  defineFileWatcherIn,
  type FileWatcherDecl,
  type FileWatcherSpec,
} from "../../shared/registry";

export interface ServerFileWatcherSpec extends FileWatcherSpec {
  /** Opens only on the main backend (its `start()` throws anywhere else). */
  mainOnly?: boolean;
}

/**
 * Declare an in-process file watcher on a worktree backend — the ONE way to
 * watch files in server code (`@parcel/watcher` and `fs.watch` are lint
 * errors elsewhere). The declaration names the watcher, describes it, and
 * fixes its policy; each `start({ dirs, label?, onChange, onLost? })`
 * opens one instance of it.
 *
 * Every declaration is an entry under File watchers in Debug → Background
 * activity: its open instances and what they watch, its backend, its last
 * change batch and its handler runs (a throwing handler is recorded as failed
 * and still surfaces as an unhandled rejection).
 *
 * ```ts
 * export const configFilesWatcher = defineFileWatcher({
 *   name: "config_v2.config-files",
 *   description: "Reloads a config the moment its .jsonc changes on disk.",
 *   extensions: [".jsonc"],
 * });
 * // register: [configFilesWatcher]
 * const w = await configFilesWatcher.start({ dirs: [dir], onChange });
 * ```
 */
export function defineFileWatcher(
  spec: ServerFileWatcherSpec,
): FileWatcherDecl & Registration {
  return defineFileWatcherIn(spec, {
    scope: spec.mainOnly === true ? "main" : "every-worktree",
    get runsHere() {
      return spec.mainOnly !== true || isMain();
    },
    declaredIn: registeringPlugin,
    onFailure: (_name, err) => {
      throw err;
    },
  });
}
