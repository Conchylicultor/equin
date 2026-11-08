import { runtimePath } from "@plugins/infra/plugins/launcher/plugins/runtime-env/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { uvCacheDir, uvPythonDir } from "../../data-dirs";

/**
 * The environment every uv invocation runs under: PATH as the runtime sees it
 * (mise's shims first, so `uv` is the release this checkout's `mise.lock`
 * records), the declared caches, and uv-managed Pythons only — the system
 * Python is never used, and never touched.
 */
export async function uvEnv(): Promise<Record<string, string | undefined>> {
  const [cacheDir, pythonDir] = await Promise.all([
    uvCacheDir.ensure(),
    uvPythonDir.ensure(),
  ]);
  return {
    ...process.env,
    PATH: runtimePath(process.env),
    UV_CACHE_DIR: cacheDir,
    UV_PYTHON_INSTALL_DIR: pythonDir,
    UV_PYTHON_PREFERENCE: "only-managed",
  };
}

/** `uv --version` from `root` (its mise.lock picks the release): `0.8.22`. */
export async function uvVersion(root: string): Promise<string> {
  let result: Awaited<ReturnType<typeof spawnCaptured>>;
  try {
    result = await spawnCaptured(["uv", "--version"], {
      cwd: root,
      env: await uvEnv(),
      timeoutMs: 30_000,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new Error(
      "uv is not on the runtime PATH. It is a mise tool: run `mise install` in this checkout.",
    );
  }
  const version = /^uv (\S+)/.exec(result.stdout.trim())?.[1];
  if (result.exitCode !== 0 || version === undefined) {
    throw new Error(
      `\`uv --version\` did not report a version (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ` +
        `${`${result.stdout}\n${result.stderr}`.trim().split("\n")[0]}`,
    );
  }
  return version;
}
