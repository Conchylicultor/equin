/**
 * The engine's Chromium on macOS runs HEADED — a real window (off-screen), so
 * the GPU draws its pages and it is the browser sites expect (`window.chrome`,
 * plugins, a hardware WebGL renderer), not the headless shell bot checks flag.
 * A headed Chromium is an ordinary app: a Dock icon, a Cmd+Tab entry, a menu
 * bar. This derives the copy that is none of those: the installed app bundle,
 * `LSBackgroundOnly` in its Info.plist, re-signed ad hoc (the edit breaks
 * Google's signature). Measured 2026-10-25: `LSUIElement` instead makes
 * Chromium abort at start ("icudtl.dat not found in bundle"); `LSBackgroundOnly`
 * runs, `lsappinfo` lists it as BackgroundOnly.
 *
 * One copy per installed build (keyed by the installed executable's path,
 * which names the build), made once and atomically (built beside, renamed
 * into place); copies of other builds are removed.
 */
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import { browserEngineAppDir } from "../data-dirs";

const MINUTE = 60_000;

/** The `.app` bundle an executable inside `Contents/MacOS/` belongs to. */
function bundleOf(executable: string): string {
  const i = executable.lastIndexOf(".app/");
  if (i < 0) throw new Error(`not inside an app bundle: ${executable}`);
  return executable.slice(0, i + ".app".length);
}

/** The background-only copy of `executable`'s app bundle; its executable path. */
export async function backgroundOnlyChromium(
  executable: string,
): Promise<string> {
  const bundle = bundleOf(executable);
  const root = browserEngineAppDir.ensure();
  const key = hashHex(executable).slice(0, 16);
  const dir = join(root, key);
  const inside = relative(bundle, executable);
  const launched = join(dir, basename(bundle), inside);

  for (const entry of readdirSync(root)) {
    if (entry !== key)
      rmSync(join(root, entry), { recursive: true, force: true });
  }
  if (existsSync(launched)) return launched;

  const building = `${dir}.building`;
  rmSync(building, { recursive: true, force: true });
  const copy = join(building, basename(bundle));
  await spawnExpectOk(["ditto", bundle, copy], {
    timeoutMs: 5 * MINUTE,
  });
  await spawnExpectOk(
    [
      "plutil",
      "-insert",
      "LSBackgroundOnly",
      "-bool",
      "true",
      join(copy, "Contents", "Info.plist"),
    ],
    { timeoutMs: MINUTE },
  );
  await spawnExpectOk(["codesign", "--force", "--sign", "-", copy], {
    timeoutMs: 5 * MINUTE,
  });
  renameSync(building, dir);
  if (!existsSync(launched)) {
    throw new Error(
      `background-only Chromium missing its executable: ${launched}`,
    );
  }
  return launched;
}
