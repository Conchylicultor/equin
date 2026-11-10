import { spawnPassthrough } from "@plugins/infra/plugins/spawn/core";
import { join } from "node:path";

/**
 * The install half of the patched addon: an install that re-creates
 * `@parcel/watcher` (a patch or version change, a fresh checkout) drops
 * `build/Release/watcher.node`, and on darwin the patched `index.js` loads
 * nothing else — so every install links it back, right there, and the addon
 * exists wherever the package does. Every install runs this: `./equin
 * install` (a new worktree), the CLI bootstrap's `ensureDeps`, a hand-typed
 * `bun install`. A missing addon afterwards is a real bug, and `index.js`
 * says so loudly.
 *
 * Before this, only `./equin build` linked it — AFTER its own install, which
 * dropped it, and after a hand-run build's parent had already loaded the
 * watcher to follow its child (`runAttached`): from 0e701ee320 (2026-11-10,
 * when `index.js` stopped falling back to upstream's prebuild) every checkout
 * that reinstalled could not build at all.
 *
 * In a child process: linking ensures the `parcel-watcher-addon` dependency
 * (the deps engine, a `cli` concern), which a provision may not import. The
 * child takes no install lock (it is a bare script, not `./equin`), so it
 * cannot deadlock on the one `ensureDeps` holds around this install.
 */
export async function linkAddonAfterInstall(): Promise<void> {
  if (process.platform !== "darwin") return;
  const script = join(import.meta.dir, "..", "..", "scripts", "link-addon.ts");
  const { exitCode, signalCode } = await spawnPassthrough([
    process.execPath,
    script,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `linking the patched @parcel/watcher addon failed (${script} exited ${exitCode}${signalCode ? `, ${signalCode}` : ""})`,
    );
  }
}
