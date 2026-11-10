/**
 * Links the patched @parcel/watcher addon into this checkout — the step this
 * plugin's provision (`../provision`) runs after every `bun install`. A script,
 * run in its own process, because a provision may import only `core`: linking
 * ensures the `parcel-watcher-addon` dependency (the deps engine, `cli`).
 */
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { linkParcelWatcherAddon } from "../cli";

await linkParcelWatcherAddon({
  root: REPO_ROOT,
  log: (line) => console.log(line),
});
