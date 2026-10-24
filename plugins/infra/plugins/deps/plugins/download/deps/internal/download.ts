import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import type {
  DepSource,
  InstallContext,
  Ready,
} from "@plugins/infra/plugins/deps/deps";

/** One pinned file: fetched from `url`, kept as `env/<name>` once its sha256 matches. */
export interface DownloadFile {
  /** The file's name inside the install's `env/`. A plain name, no `/`. */
  readonly name: string;
  readonly url: string;
  /** Lowercase hex sha256 the downloaded bytes must match. */
  readonly sha256: string;
}

/**
 * Post-processing run inside `env/` once every file is downloaded and checked
 * (decompress, compile a CSV into a lookup table, drop what is no longer
 * needed).
 */
export interface DownloadDerive {
  /**
   * The version of what `run` produces. Part of the identity, so a new
   * derivation is a new install.
   */
  readonly version: string;
  /**
   * The names `run` leaves in `env/`: what the install is made of from then
   * on. Checked right after `run` and on every `isIntact`.
   */
  readonly outputs: readonly string[];
  /** Runs with `ctx.dir` = `env/`, holding the downloaded files. Throws on failure. */
  run(ctx: InstallContext): Promise<void>;
}

/** Pinned files, downloaded and sha256-checked, optionally post-processed. */
export interface DownloadSource extends DepSource<"download"> {
  readonly files: readonly DownloadFile[];
  readonly derive?: DownloadDerive;
}

const MINUTE = 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9._-]+$/;

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * The installer kind for pinned files.
 *
 * - **Identity**: every file's url and sha256, plus `derive.version`. Moving a
 *   pin (a new month of a dataset, a new commit) is a new identity, so a new
 *   install next to the old one.
 * - **Install**: each file is fetched with `curl` into `env/<name>.part` (its
 *   progress meter lands in the install log), its sha256 checked, then renamed
 *   to `env/<name>`. A mismatch throws — a pinned file that changed is never
 *   something to work around — and the engine records the failure, so the
 *   dependency never reads as installed. `derive`, if any, then runs in `env/`.
 * - **Staying current**: this kind has no updater. A frozen dataset says
 *   `updates: { none: "<why>" }` on its declaration.
 */
export function download(opts: {
  files: readonly DownloadFile[];
  derive?: DownloadDerive;
  /** Longest one file's download may take. Default: 30 minutes. */
  timeoutMs?: number;
  /** See `DepSource.admission`: only for a download too small to be worth a host grant. */
  admission?: { readonly none: string };
}): DownloadSource {
  const { files, derive } = opts;
  const timeoutMs = opts.timeoutMs ?? 30 * MINUTE;
  validate(files, derive);
  const outputs = derive?.outputs ?? files.map((f) => f.name);

  return {
    kind: "download",
    // For people: the names and where they come from (each full URL is in the identity).
    label: `${files.map((f) => f.name).join(", ")} from ${[
      ...new Set(files.map((f) => new URL(f.url).host || f.url)),
    ].join(", ")}`,
    files,
    ...(derive === undefined ? {} : { derive }),
    ...(opts.admission === undefined ? {} : { admission: opts.admission }),

    async identityInputs() {
      const inputs: Record<string, string> = {};
      for (const f of files) inputs[`file:${f.name}`] = `${f.url} ${f.sha256}`;
      if (derive !== undefined) inputs.derive = derive.version;
      return inputs;
    },

    async install(ctx) {
      mkdirSync(ctx.dir, { recursive: true });
      for (const f of files) {
        const part = join(ctx.dir, `${f.name}.part`);
        await ctx.run(
          [
            "curl",
            "--fail",
            "--location",
            "--retry",
            "3",
            "--retry-delay",
            "2",
            "--connect-timeout",
            "30",
            "--output",
            part,
            f.url,
          ],
          { cwd: ctx.dir, env: { ...process.env }, timeoutMs },
        );
        const actual = await sha256OfFile(part);
        if (actual !== f.sha256) {
          rmSync(part, { force: true });
          throw new Error(
            `${f.url} downloaded with sha256 ${actual}, expected the pinned ${f.sha256}`,
          );
        }
        renameSync(part, join(ctx.dir, f.name));
        ctx.log(`${f.name}: sha256 matches the pin`);
      }
      if (derive !== undefined) {
        await derive.run(ctx);
        const missing = derive.outputs.filter(
          (name) => !existsSync(join(ctx.dir, name)),
        );
        if (missing.length > 0) {
          throw new Error(
            `derive v${derive.version} finished without producing ${missing.join(", ")} in ${ctx.dir}`,
          );
        }
      }
    },

    isIntact: (dir) => outputs.every((name) => existsSync(join(dir, name))),
  };
}

function validate(
  files: readonly DownloadFile[],
  derive: DownloadDerive | undefined,
): void {
  if (files.length === 0)
    throw new Error("download: declare at least one file");
  const seen = new Set<string>();
  for (const f of files) {
    if (!NAME.test(f.name)) {
      throw new Error(
        `download: file name ${JSON.stringify(f.name)} must match ${NAME} — it names a file inside env/.`,
      );
    }
    if (seen.has(f.name)) {
      throw new Error(
        `download: file name ${JSON.stringify(f.name)} is declared twice`,
      );
    }
    seen.add(f.name);
    if (!SHA256.test(f.sha256)) {
      throw new Error(
        `download: ${f.name}'s sha256 ${JSON.stringify(f.sha256)} is not 64 lowercase hex characters`,
      );
    }
  }
  if (derive !== undefined) {
    if (derive.outputs.length === 0) {
      throw new Error(
        "download: a derive must name the outputs it leaves in env/",
      );
    }
    for (const name of derive.outputs) {
      if (!NAME.test(name)) {
        throw new Error(
          `download: derive output ${JSON.stringify(name)} must match ${NAME}`,
        );
      }
    }
  }
}

/**
 * The path of one file of an installed download — a downloaded file, or a
 * `derive` output. Throws when the source declares no such name, so a typo is
 * loud rather than a missing-file error later.
 */
export function downloadedFile(
  ready: Ready<DownloadSource>,
  name: string,
): string {
  const source = ready.dep.source;
  const names = source.derive?.outputs ?? source.files.map((f) => f.name);
  if (!names.includes(name)) {
    throw new Error(
      `${ready.dep.id} has no file ${JSON.stringify(name)}; it holds ${names.join(", ")}`,
    );
  }
  return join(ready.dir, name);
}
