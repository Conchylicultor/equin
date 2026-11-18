import { availableParallelism } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { download } from "@plugins/infra/plugins/deps/plugins/download/deps";

/**
 * One GNU bash release install.sh must work under, built from its pinned
 * source tarball: `bash-<version>` in `env/`.
 */
interface PinnedBash {
  readonly version: string;
  readonly sha256: string;
  /**
   * C flags for the build. 3.2 is K&R-era C: today's compilers (clang ≥ 16,
   * gcc ≥ 14) reject its implicit declarations unless told it is gnu89.
   */
  readonly cflags: string;
  /** 3.2's Makefile races on version.h under `make -j`. */
  readonly parallel: boolean;
  /**
   * The release whose `support/config.guess` and `config.sub` replace this
   * one's: 3.2's date from 2002 and know no aarch64, so its configure stops
   * ("cannot guess build type") on ARM Linux — Docker on Apple silicon, arm64
   * servers. The newer release's tarball is pinned too.
   */
  readonly configScriptsFrom: string | null;
}

/**
 * The two bash lines a `curl … | bash` meets: 3.2, the one every Mac ships as
 * /bin/bash, and 5.x, every Linux's (and Homebrew's). `read -t` answering a
 * timeout differently in 3.2 and in ≥ 4 once made the terminal view quit on
 * Linux while every test passed under the Mac's 3.2.
 */
export const PINNED_BASHES = [
  {
    version: "3.2.57",
    sha256: "3fa9daf85ebf35068f090ce51283ddeeb3c75eb5bc70b1a4a7cb05868bfe06a4",
    cflags:
      "-O2 -w -std=gnu89 -Wno-implicit-function-declaration -Wno-implicit-int -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-return-type",
    parallel: false,
    configScriptsFrom: "5.2.37",
  },
  {
    version: "5.2.37",
    sha256: "9599b22ecd1d5787ad7d3b7bf0c59f312b3396d1e281175dd1f8a4014da621ff",
    cflags: "-O2 -w",
    parallel: true,
    configScriptsFrom: null,
  },
] as const satisfies readonly PinnedBash[];

export type PinnedBashVersion = (typeof PINNED_BASHES)[number]["version"];

export const bashBinaryName = (version: PinnedBashVersion) => `bash-${version}`;

const tarball = (version: string) => `bash-${version}.tar.gz`;

/** A configure + make of one release; minutes on a slow machine. */
const BUILD_TIMEOUT_MS = 20 * 60_000;

/**
 * GNU bash 3.2 and 5.2, built from source: the shells install.sh's tests run
 * the script under, whatever bash this machine has (a Mac has only 3.2, a
 * Linux only 5.x).
 */
export const installerTestBashes = defineDep({
  id: "installer-test-bashes",
  owner: "installer",
  description:
    "GNU bash 3.2 and 5.2 built from source: install.sh's tests run under both",
  sizeHint: "≈3 MB",
  source: download({
    files: PINNED_BASHES.map((b) => ({
      name: tarball(b.version),
      url: `https://ftpmirror.gnu.org/gnu/bash/${tarball(b.version)}`,
      sha256: b.sha256,
    })),
    derive: {
      version: "2",
      outputs: PINNED_BASHES.map((b) => bashBinaryName(b.version)),
      run: async (ctx) => {
        for (const b of PINNED_BASHES) {
          const src = join(ctx.dir, `src-${b.version}`);
          const run = (argv: string[], env: Record<string, string> = {}) =>
            ctx.run(argv, {
              cwd: src,
              env: { ...process.env, ...env },
              timeoutMs: BUILD_TIMEOUT_MS,
            });
          await ctx.run(["mkdir", src], {
            cwd: ctx.dir,
            env: { ...process.env },
            timeoutMs: 10_000,
          });
          await run([
            "tar",
            "xzf",
            join(ctx.dir, tarball(b.version)),
            "--strip-components",
            "1",
          ]);
          if (b.configScriptsFrom !== null)
            await run([
              "tar",
              "xzf",
              join(ctx.dir, tarball(b.configScriptsFrom)),
              "--strip-components",
              "1",
              `bash-${b.configScriptsFrom}/support/config.guess`,
              `bash-${b.configScriptsFrom}/support/config.sub`,
            ]);
          await run(["./configure", "--without-bash-malloc", "--disable-nls"], {
            CFLAGS: b.cflags,
            CFLAGS_FOR_BUILD: b.cflags,
          });
          await run([
            "make",
            `-j${b.parallel ? availableParallelism() : 1}`,
            `CFLAGS_FOR_BUILD=${b.cflags}`,
            "bash",
          ]);
          await run(["cp", "bash", join(ctx.dir, bashBinaryName(b.version))]);
          await rm(src, { recursive: true, force: true });
        }
        for (const b of PINNED_BASHES)
          await rm(join(ctx.dir, tarball(b.version)));
      },
    },
  }),
  // 3.2.57's parse.y carries patches up to 2014, its shipped y.tab.c is from
  // 2006: make regenerates the parser, so it needs yacc (bison) — a Mac's
  // developer tools have it, a Linux may not.
  systemPackages: {
    linux: {
      apt: ["build-essential", "bison"],
      forUser: "a C compiler, make and bison, to build bash from source",
    },
  },
  updates: {
    none: "pinned to the bash lines users run; bump a version and its sha256 by hand",
  },
});
