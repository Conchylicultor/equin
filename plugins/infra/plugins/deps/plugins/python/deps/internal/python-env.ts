import { createHash } from "node:crypto";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type { DepSource } from "@plugins/infra/plugins/deps/deps";
import { uvEnv, uvVersion } from "./uv";

/** The files of a uv project that decide what its env contains. */
const INPUT_FILES = ["pyproject.toml", "uv.lock", ".python-version"] as const;

const MINUTE = 60_000;

/** A Python env built from one uv project (a plugin's `python/` folder). */
export interface PythonEnvSource extends DepSource<"python"> {
  /** Repo-relative path of the uv project, e.g. `plugins/<…>/python`. */
  readonly project: string;
  readonly updater: "uv";
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * The installer kind for Python: one uv project, installed with
 * `uv sync --frozen` into the dependency's own env.
 *
 * - **Identity**: the hashes of `pyproject.toml`, `uv.lock` and
 *   `.python-version`, plus the uv version. The project's own `.py` source is
 *   NOT part of it and is NOT installed into the env (`--no-install-project`):
 *   `runPython` runs it from the checkout, so one env serves every worktree on
 *   the same lock while each runs its own code.
 * - **Install**: uv downloads its own CPython into the declared
 *   `cache/uv-python`; the system Python is never used.
 * - **Kept current** by the `uv` updater, which moves the project's `uv.lock`
 *   and its exact `.python-version` pin.
 */
export function pythonEnv(opts: { project: string }): PythonEnvSource {
  const { project } = opts;
  return {
    kind: "python",
    label: project,
    project,
    updater: "uv",

    async identityInputs(root) {
      const inputs: Record<string, string> = {};
      for (const file of INPUT_FILES) {
        const path = join(root, project, file);
        if (!(await exists(path))) {
          throw new Error(
            `${project}/${file} is missing: a python/ project needs pyproject.toml, a committed uv.lock and .python-version.`,
          );
        }
        inputs[file] = await sha256(path);
      }
      // `3.12` would let two machines on the same identity run different
      // patch releases; the `uv` updater moves the exact pin.
      const pinned = (
        await readFile(join(root, project, ".python-version"), "utf8")
      ).trim();
      if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
        throw new Error(
          `${project}/.python-version is "${pinned}": pin an exact CPython release (e.g. 3.14.7), which the uv updater keeps current.`,
        );
      }
      inputs.uv = await uvVersion(root);
      return inputs;
    },

    async install(ctx) {
      await ctx.run(
        [
          "uv",
          "sync",
          "--frozen",
          "--no-install-project",
          "--no-dev",
          "--project",
          join(ctx.root, project),
        ],
        {
          cwd: ctx.root,
          env: { ...(await uvEnv()), UV_PROJECT_ENVIRONMENT: ctx.dir },
          // A cold install downloads a CPython and every wheel.
          timeoutMs: 30 * MINUTE,
        },
      );
    },

    // `bin/python` is a symlink into uv's managed Pythons; `exists`
    // follows it, so a reclaimed `cache/uv-python` reads as not intact.
    isIntact: (dir) => exists(join(dir, "bin", "python")),
  };
}
