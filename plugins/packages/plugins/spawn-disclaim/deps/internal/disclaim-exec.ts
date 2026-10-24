import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { build } from "@plugins/infra/plugins/deps/plugins/build/deps";

/** The C compiler: `$CC` when set, else `cc` — resolved when the declaration loads. */
const cc = process.env.CC ?? "cc";

/** Node's arch names in clang's `-arch` terms (the two macOS has). */
const CLANG_ARCH: Record<string, string> = { arm64: "arm64", x64: "x86_64" };

/**
 * The `disclaim-exec` helper, compiled from this checkout's `native/` source
 * into the deps cache: identity = the source's hash, the compiler's version and
 * the target. macOS only — the responsibility SPI it calls exists nowhere else,
 * and the compile needs Apple's clang (`-arch`), so it can be sealed for either
 * macOS arch and for no other platform.
 *
 * No host admission: one ~200 ms compile of one file, awaited (briefly) on the
 * way into an agent launch.
 */
export const disclaimExec = defineDep({
  id: "disclaim-exec",
  owner: "packages/spawn-disclaim",
  description:
    "The native helper an agent runs claude through, so macOS attributes claude's permission prompts to claude instead of the gateway",
  sizeHint: "≈50 KB",
  source: build({
    inputs: ["plugins/packages/plugins/spawn-disclaim/native/**"],
    tool: { versionArgv: [cc, "--version"] },
    output: "disclaim-exec",
    admission: {
      none: "one ~200 ms compile of one C file, awaited on the way into an agent launch",
    },
    targets: (target) =>
      target.platform === "darwin" && CLANG_ARCH[target.arch] !== undefined
        ? { ok: true }
        : {
            ok: false,
            reason: `disclaim-exec is macOS-only (arm64 / x64); ${target.platform}/${target.arch} has no responsibility SPI`,
          },
    run: async (ctx) => {
      const arch = CLANG_ARCH[ctx.target.arch];
      if (ctx.target.platform !== "darwin" || arch === undefined) {
        throw new Error(
          `disclaim-exec is macOS-only (arm64 / x64), not ${ctx.target.platform}/${ctx.target.arch}`,
        );
      }
      await ctx.run(
        [
          cc,
          "-O2",
          "-Wall",
          "-Werror",
          "-std=c11",
          "-arch",
          arch,
          "-o",
          ctx.output,
          "plugins/packages/plugins/spawn-disclaim/native/disclaim-exec.c",
        ],
        { cwd: ctx.root, env: { ...process.env }, timeoutMs: 120_000 },
      );
    },
  }),
  bundle: {
    optional:
      "agents run claude without disclaiming, so their permission prompts name the app's gateway (a backend cannot read the bundle's deps yet)",
  },
  updates: { none: "built from this checkout's own source" },
});
