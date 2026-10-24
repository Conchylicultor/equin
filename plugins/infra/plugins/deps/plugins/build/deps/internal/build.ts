import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  hostTarget,
  type DepSource,
  type DepTarget,
  type InstallContext,
  type Ready,
  type TargetedSource,
} from "@plugins/infra/plugins/deps/deps";

/** The toolchain a build runs, identified by what it says its version is. */
export interface BuildTool {
  /**
   * The command that prints the tool's version — `["cc", "--version"]`,
   * `["go", "version"]`. Its stdout is part of the identity, so a new compiler
   * is a new build. A non-zero exit throws: a missing tool is a failed
   * dependency, never an install against an unknown toolchain.
   */
  readonly versionArgv: readonly string[];
  /**
   * The environment the version command runs under, read when the identity is
   * derived — the same one `run` builds with, so the identity names the
   * toolchain the build really uses (a mise-pinned one rather than whatever is
   * first on the caller's PATH). Omitted: `process.env`.
   */
  readonly env?: () => Record<string, string | undefined>;
}

/** What a build's `run` gets: the engine's install context, plus where to write. */
export interface BuildContext extends InstallContext {
  /** Absolute path the build must leave its output at (`env/<output>`). */
  readonly output: string;
  /**
   * The platform and architecture to build for: this host's for the cache,
   * a release bundle's when `sealDep` seals it for another platform. A `run`
   * that honours `targets` must turn it into its toolchain's own terms
   * (`GOOS`/`GOARCH`, `cc -arch`).
   */
  readonly target: DepTarget;
}

/**
 * Which targets besides this host a build's `run` can produce.
 * `"any"`: the toolchain cross-compiles to every target (Go). A function
 * answers per target, with the reason when it cannot. Omitted: this host only
 * — a build that never said it can cross-compile is never asked to.
 */
export type BuildTargets =
  "any" | ((target: DepTarget) => { ok: true } | { ok: false; reason: string });

/** Built from files of this checkout by a declared toolchain. */
export interface BuildSource extends DepSource<"build"> {
  /** Repo-relative `git ls-files` globs whose files the build reads. */
  readonly inputs: readonly string[];
  readonly tool: BuildTool;
  /** The file the build leaves in `env/`, for this source's target. A plain name, no `/`. */
  readonly output: string;
  /** Always present: a build's output is one relocatable file, so it can be sealed. */
  forTarget(target: DepTarget): TargetedSource;
}

const MINUTE = 60_000;
const NAME = /^[A-Za-z0-9._-]+$/;
/** Reading the tool's version and listing the inputs are metadata reads. */
const PROBE_TIMEOUT_MS = MINUTE;

/**
 * The installer kind for something built from this checkout's own source (a
 * native shim, the gateway binary).
 *
 * - **Identity**: the sha256 of every file the `inputs` globs match (tracked
 *   and untracked-but-not-ignored, read from the working tree, so an
 *   uncommitted edit is a new build), the tool's version output, and the
 *   target platform/arch. Nothing is typed in by hand. A glob that matches no
 *   file throws: a declaration that builds from nothing is a typo.
 * - **Targets**: the declaration's own source builds for this host;
 *   `forTarget` (what `sealDep` calls for a release bundle) builds for another
 *   platform when `targets` says the toolchain can, and says why not otherwise.
 * - **Install**: `run(ctx)` builds straight into `ctx.dir`, leaving
 *   `ctx.output`; a run that finishes without it throws. `then(ctx, output)`,
 *   if declared, runs next on the produced file (code-signing it) before the
 *   install counts as ready; a throw fails the install like a failed build.
 *   What `then` reads (a signing identity) is NOT part of the identity: it
 *   finishes a build, it does not change what was built. `isIntact` is "the
 *   output exists".
 * - **Staying current**: the source moves with the repo, so the declaration
 *   says `updates: { none: "built from this checkout's own source" }`.
 * - **Admission**: under the caller's host admission, unless the declaration
 *   passes `admission: { none: "<why>" }` for a build too small to be worth a
 *   grant (see `DepSource.admission`).
 */
export function build(opts: {
  inputs: readonly string[];
  tool: BuildTool;
  /** The output's file name — per target when it differs (`.dylib` / `.so`). */
  output: string | ((target: DepTarget) => string);
  run(ctx: BuildContext): Promise<void>;
  /**
   * Runs once `run` has produced the output, with its absolute path (the same
   * as `ctx.output`) — post-processing in place, such as code-signing it.
   * Nothing it reads is part of the identity.
   */
  then?: (ctx: BuildContext, built: string) => Promise<void>;
  targets?: BuildTargets;
  admission?: { readonly none: string };
}): BuildSource {
  const { inputs, tool, run } = opts;
  const outputFor = (target: DepTarget): string =>
    typeof opts.output === "string" ? opts.output : opts.output(target);
  const host = hostTarget();
  validate(inputs, tool, outputFor(host));

  const canBuild = (
    target: DepTarget,
  ): { ok: true } | { ok: false; reason: string } => {
    if (target.platform === host.platform && target.arch === host.arch) {
      return { ok: true };
    }
    if (opts.targets === "any") return { ok: true };
    if (opts.targets === undefined) {
      return {
        ok: false,
        reason: `this build is declared for the host only (${host.platform}/${host.arch}); it does not say it can cross-compile`,
      };
    }
    return opts.targets(target);
  };

  const sourceFor = (target: DepTarget): BuildSource => {
    const output = outputFor(target);
    validate(inputs, tool, output);
    return {
      kind: "build",
      label: `${output} from ${inputs.join(", ")}`,
      inputs,
      tool,
      output,
      ...(opts.admission === undefined ? {} : { admission: opts.admission }),

      async identityInputs(root) {
        const identity: Record<string, string> = {
          tool: await toolVersion(tool, root),
          target: `${target.platform}/${target.arch}`,
        };
        for (const [path, sha] of await hashInputs(root, inputs)) {
          identity[`file:${path}`] = sha;
        }
        return identity;
      },

      async install(ctx) {
        mkdirSync(ctx.dir, { recursive: true });
        const out = join(ctx.dir, output);
        const buildCtx: BuildContext = { ...ctx, output: out, target };
        await run(buildCtx);
        if (!existsSync(out)) {
          throw new Error(`the build finished without producing ${out}`);
        }
        if (opts.then !== undefined) await opts.then(buildCtx, out);
      },

      isIntact: (dir) => existsSync(join(dir, output)),

      forTarget(other) {
        const can = canBuild(other);
        return can.ok ? { ok: true, source: sourceFor(other) } : can;
      },
    };
  };

  return sourceFor(host);
}

async function toolVersion(tool: BuildTool, root: string): Promise<string> {
  const argv = [...tool.versionArgv];
  const result = await spawnCaptured(argv, {
    cwd: root,
    env: tool.env === undefined ? { ...process.env } : tool.env(),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${argv.join(" ")}\` failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${result.stderr.trim() || "(no output)"}`,
    );
  }
  return result.stdout.trim();
}

/** Every file each glob matches under `root`, with its sha256, sorted by path. */
async function hashInputs(
  root: string,
  globs: readonly string[],
): Promise<Map<string, string>> {
  const files = new Set<string>();
  for (const glob of globs) {
    const result = await spawnCaptured(
      [
        "git",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        `:(glob)${glob}`,
      ],
      { cwd: root, timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `git ls-files ${glob} failed in ${root} (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    const matched = result.stdout.split("\0").filter((p) => p !== "");
    // A tracked file deleted in the working tree is listed by --cached; it is
    // not an input any more (the set of names changes, so the identity does).
    const present = matched.filter((p) => existsSync(join(root, p)));
    if (present.length === 0) {
      throw new Error(`build input ${glob} matches no file in ${root}`);
    }
    for (const p of present) files.add(p);
  }
  const hashes = new Map<string, string>();
  for (const path of [...files].sort()) {
    hashes.set(
      path,
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex"),
    );
  }
  return hashes;
}

function validate(
  inputs: readonly string[],
  tool: BuildTool,
  output: string,
): void {
  if (inputs.length === 0) {
    throw new Error("build: declare at least one input glob");
  }
  for (const glob of inputs) {
    if (isAbsolute(glob) || glob.split("/").includes("..")) {
      throw new Error(
        `build: input ${JSON.stringify(glob)} must be relative to the repo root, without ..`,
      );
    }
  }
  if (tool.versionArgv.length === 0) {
    throw new Error("build: tool.versionArgv must name a command");
  }
  if (!NAME.test(output)) {
    throw new Error(
      `build: output ${JSON.stringify(output)} must match ${NAME} — it names a file inside env/.`,
    );
  }
}

/**
 * The path of an installed build's output. The declaration's `output` is this
 * host's; a sealed bundle's payload is for the bundle's platform, which the
 * engine refuses to read anywhere but on that platform — so the two agree.
 */
export function builtFile(ready: Ready<BuildSource>): string {
  return join(ready.dir, ready.dep.source.output);
}
