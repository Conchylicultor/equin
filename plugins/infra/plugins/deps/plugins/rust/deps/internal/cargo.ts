import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runtimePath } from "@plugins/infra/plugins/launcher/core";
import type { Ready } from "@plugins/infra/plugins/deps/deps";
import {
  build,
  type BuildContext,
  type BuildSource,
} from "@plugins/infra/plugins/deps/plugins/build/deps";
import { cargoTargetDir } from "../../data-dirs";

const MINUTE = 60_000;
/** A cold release build of a Tauri-sized crate is minutes of CPU. */
const BUILD_TIMEOUT_MS = 45 * MINUTE;

/** A crate is a plugin's `rust/` folder: `plugins/<…>/rust`. */
const CRATE = /^plugins\/(?:[A-Za-z0-9._-]+\/)+rust$/;
/** A cargo binary target's name (`[[bin]] name`, or the package name). */
const BIN = /^[A-Za-z0-9_-]+$/;

/** A crate built by cargo: a `build` source that also says which binary it is. */
export interface CargoSource extends BuildSource {
  /** Repo-relative crate dir, a plugin's `rust/` folder. */
  readonly crate: string;
  /** The cargo binary target built (`cargo build --bin <bin>`). */
  readonly bin: string;
  /** The binary's path inside `env/` — what {@link cargoBinary} returns. */
  readonly binary: string;
}

/**
 * What a crate's build leaves in `env/`. Either the binary itself, under its
 * own name, or — with `then` — whatever `then` assembles from it (a macOS
 * `.app` around it), declared as `output`, with `binary` naming where inside
 * `env/` the binary ended up.
 */
export type CargoBuildSpec =
  | { readonly crate: string; readonly bin: string }
  | {
      readonly crate: string;
      readonly bin: string;
      /** The file or directory `then` leaves in `env/`. A plain name, no `/`. */
      readonly output: string;
      /** `env/`-relative path of the binary inside `output` (`equin.app/Contents/MacOS/equin`). */
      readonly binary: string;
      /**
       * Assemble `ctx.output` from `built` — the binary in the SHARED cargo
       * target dir, which the next build of the crate overwrites: copy it,
       * never move or link it.
       */
      readonly then: (ctx: BuildContext, built: string) => Promise<void>;
    };

/**
 * The environment every cargo and rustc invocation runs under: PATH as the
 * runtime sees it (mise's shims first, so `cargo` / `rustc` are the release
 * this checkout's `mise.lock` records, never rustup's default), and — for a
 * build — the crate's own target dir in the shared cache.
 */
export function cargoEnv(
  opts: { targetDir?: string } = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: runtimePath(process.env),
    ...(opts.targetDir === undefined
      ? {}
      : { CARGO_TARGET_DIR: opts.targetDir }),
  };
}

/**
 * One cargo command, as the argv and environment to spawn it with: the only
 * spelling of `cargo` outside this kind (`rust/no-bare-cargo`), so every
 * caller — the cargo updater, its smoke tests — runs the mise-pinned toolchain.
 */
export function cargoCommand(args: readonly string[]): {
  argv: string[];
  env: Record<string, string | undefined>;
} {
  return { argv: ["cargo", ...args], env: cargoEnv() };
}

/** The cargo `target/` dir of one crate, inside the shared `cargo-target` cache. */
export function crateTargetDir(crate: string): string {
  return join(cargoTargetDir.ensure(), crate.replaceAll("/", "__"));
}

/** The argv `cargoBuild` runs to build `bin` of the crate at `crate` under `root`. */
export function cargoBuildArgv(
  root: string,
  crate: string,
  bin: string,
): string[] {
  return [
    "cargo",
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    join(root, crate, "Cargo.toml"),
    "--bin",
    bin,
  ];
}

/**
 * The installer kind for a plugin's `rust/` crate, ON the `build` kind — so
 * identity, the intact check and the install lock are the build kind's own.
 *
 * - **Identity**: every file of the crate (`git ls-files`, so `target/` —
 *   ignored — never counts), `Cargo.lock` required (a crate without one fails
 *   to derive, since `--locked` would refuse it anyway), plus `rustc -vV`
 *   run through the mise shims from the repo root: a new Rust is a new build.
 *   A crate is self-contained: a path dependency outside its `rust/` folder is
 *   not an input.
 * - **Install**: `cargo build --release --locked --bin <bin>` from the repo
 *   root (so the root's `mise.toml` picks the toolchain, never a crate-level
 *   `rust-toolchain.toml`), with `CARGO_TARGET_DIR` the crate's dir in the
 *   shared `cargo-target` cache; then the binary is copied into `env/`, or
 *   handed to `then`.
 * - **Targets**: this host only. Cross-compiling needs a rustup target and a
 *   foreign linker, which nothing provides yet.
 * - **Staying current**: the source moves with the repo (`updates: { none:
 *   "built from this checkout's own source" }`); the crate's `Cargo.lock` is
 *   moved by the `cargo` updater (`rust/plugins/cargo-updater`).
 */
export function cargoBuild(spec: CargoBuildSpec): CargoSource {
  const { crate, bin } = spec;
  validate(spec);
  const assembled = "then" in spec ? spec : null;
  const output = assembled === null ? bin : assembled.output;
  const binary = assembled === null ? bin : assembled.binary;

  const source = build({
    inputs: [`${crate}/**`, `${crate}/Cargo.toml`, `${crate}/Cargo.lock`],
    tool: { versionArgv: ["rustc", "-vV"], env: () => cargoEnv() },
    output,
    async run(ctx) {
      const targetDir = crateTargetDir(crate);
      await ctx.run(cargoBuildArgv(ctx.root, crate, bin), {
        cwd: ctx.root,
        env: cargoEnv({ targetDir }),
        timeoutMs: BUILD_TIMEOUT_MS,
      });
      const built = join(targetDir, "release", bin);
      if (!existsSync(built)) {
        throw new Error(
          `cargo build finished without producing ${built} — is \`${bin}\` a binary target of ${crate}/Cargo.toml?`,
        );
      }
      if (assembled === null) {
        copyFileSync(built, ctx.output);
        chmodSync(ctx.output, 0o755);
        return;
      }
      await assembled.then(ctx, built);
      if (!existsSync(join(ctx.dir, binary))) {
        throw new Error(
          `cargoBuild ${crate}: \`then\` finished without leaving the binary at env/${binary}`,
        );
      }
    },
  });
  return {
    ...source,
    label: `${bin} from ${crate}`,
    crate,
    bin,
    binary,
  };
}

function validate(spec: CargoBuildSpec): void {
  if (!CRATE.test(spec.crate)) {
    throw new Error(
      `cargoBuild: crate ${JSON.stringify(spec.crate)} must be a plugin's rust/ folder, repo-relative (plugins/<…>/rust)`,
    );
  }
  if (!BIN.test(spec.bin)) {
    throw new Error(
      `cargoBuild: bin ${JSON.stringify(spec.bin)} must match ${BIN} — it names a cargo binary target`,
    );
  }
  if ("then" in spec) {
    const parts = spec.binary.split("/");
    if (
      isAbsolute(spec.binary) ||
      parts.includes("..") ||
      parts[0] !== spec.output
    ) {
      throw new Error(
        `cargoBuild: binary ${JSON.stringify(spec.binary)} must be a path inside output ${JSON.stringify(spec.output)} (${spec.output}/…), without ..`,
      );
    }
  }
}

/** The built binary of an installed crate — the copy in the deps cache, never the target dir's. */
export function cargoBinary(ready: Ready<CargoSource>): string {
  return join(ready.dir, ready.dep.source.binary);
}
