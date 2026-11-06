import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { build } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { readFile, realpath } from "@plugins/packages/plugins/timed-fs/core";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The C++ compiler: `$CXX` when set, else `c++` — resolved when the declaration loads. */
const cxx = process.env.CXX ?? "c++";

/**
 * Where a checkout's `@parcel/watcher` sits, the package its `bun.lock` and
 * `patchedDependencies` installed: the patched source this build compiles,
 * and the `build/Release/` its `index.js` loads first.
 */
export async function parcelWatcherPackageDir(root: string): Promise<string> {
  return realpath(join(root, "node_modules", "@parcel", "watcher"));
}

/**
 * A line only the patched kqueue backend holds. The build refuses source
 * without it: compiling upstream's would ship the leak under the patched name
 * (a checkout whose `node_modules` predates the patch).
 */
const PATCH_MARKER = "std::unordered_set<int> &closing";

/** binding.gyp's darwin target: the shared sources plus every darwin backend. */
const SOURCES = [
  "src/binding.cc",
  "src/Watcher.cc",
  "src/Backend.cc",
  "src/DirTree.cc",
  "src/Glob.cc",
  "src/Debounce.cc",
  "src/watchman/BSER.cc",
  "src/watchman/WatchmanBackend.cc",
  "src/shared/BruteForceBackend.cc",
  "src/unix/fts.cc",
  "src/macos/FSEventsBackend.cc",
  "src/kqueue/KqueueBackend.cc",
];

/** binding.gyp's darwin defines and flags (node-gyp's own: C++17, exceptions on). */
const COMPILE_FLAGS = [
  "-std=c++17",
  "-O2",
  "-fPIC",
  "-fexceptions",
  "-fstack-protector-strong",
  "-DNAPI_DISABLE_CPP_EXCEPTIONS",
  "-DWATCHMAN",
  "-DBRUTE_FORCE",
  "-DFS_EVENTS",
  "-DKQUEUE",
];

const MINUTE = 60_000;

/**
 * `@parcel/watcher`'s native addon, compiled from the patched source
 * (`patches/@parcel%2Fwatcher@*.patch`): its kqueue backend closes the
 * descriptor of a watched file that is deleted or renamed, which upstream
 * 2.6.0 drops from its tables and never closes — one leaked descriptor per
 * followed file that goes, for the life of the process
 * (research/2026-11-06-infra-parcel-kqueue-fd-leak.md).
 *
 * Darwin only: kqueue is the backend patched, and the one the engine runs
 * there (`writesWhileOpen`). Elsewhere the prebuilt addon loads.
 *
 * Its identity is the patch, this declaration (sources and flags), the
 * plugin's `package.json` (the Node-API headers' version) and
 * `$CXX --version`. `./equin build` ensures it and copies it into the
 * checkout's `@parcel/watcher/build/Release/`, which the patched `index.js`
 * loads ahead of the prebuild (`linkParcelWatcherAddon`, the `cli/` barrel).
 *
 * It takes no host admission: it is awaited inside `build`, which already
 * holds its host grant, so queuing for a background unit could wait on the
 * build itself. Cold it is ~20 s of CPU across twelve parallel compiles, once
 * per machine per identity.
 */
export const parcelWatcherAddon = defineDep({
  id: "parcel-watcher-addon",
  owner: "infra/file-watcher/parcel-addon",
  description:
    "@parcel/watcher's native addon built from the patched source (kqueue closes a deleted or renamed file's descriptor)",
  sizeHint: "≈400 KB",
  source: build({
    inputs: [
      "patches/@parcel%2Fwatcher@*.patch",
      "plugins/infra/plugins/file-watcher/plugins/parcel-addon/deps/internal/parcel-addon.ts",
      "plugins/infra/plugins/file-watcher/plugins/parcel-addon/package.json",
    ],
    tool: { versionArgv: [cxx, "--version"] },
    output: "watcher.node",
    admission: {
      none: "awaited inside `build`, which already holds its host grant",
    },
    run: async (ctx) => {
      if (ctx.target.platform !== "darwin") {
        throw new Error(
          `parcel-watcher-addon builds the darwin (kqueue) addon only, not ${ctx.target.platform}`,
        );
      }
      const pkg = await parcelWatcherPackageDir(ctx.root);
      const kqueue = await readFile(
        join(pkg, "src/kqueue/KqueueBackend.cc"),
        "utf8",
      );
      if (!kqueue.includes(PATCH_MARKER)) {
        throw new Error(
          `${pkg} holds upstream's kqueue backend, not the patched one: run \`./equin install\` so bun applies patches/@parcel%2Fwatcher@*.patch`,
        );
      }
      // node-addon-api is @parcel/watcher's own dependency, resolved from it;
      // node_api.h comes from node-api-headers, this plugin's dependency.
      const addonApi = dirname(
        createRequire(join(pkg, "package.json")).resolve(
          "node-addon-api/package.json",
        ),
      );
      const nodeApi = join(
        dirname(
          createRequire(
            join(
              ctx.root,
              "plugins/infra/plugins/file-watcher/plugins/parcel-addon/package.json",
            ),
          ).resolve("node-api-headers/package.json"),
        ),
        "include",
      );
      const objDir = join(ctx.dir, "obj");
      await mkdir(objDir, { recursive: true });
      const run = (argv: string[]): Promise<void> =>
        ctx.run(argv, {
          cwd: pkg,
          env: { ...process.env },
          timeoutMs: 10 * MINUTE,
        });
      const objects = SOURCES.map((_, i) => join(objDir, `${i}.o`));
      await Promise.all(
        SOURCES.map((src, i) =>
          run([
            cxx,
            ...COMPILE_FLAGS,
            `-I${addonApi}`,
            `-I${nodeApi}`,
            "-c",
            src,
            "-o",
            objects[i]!,
          ]),
        ),
      );
      await run([
        cxx,
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        "-framework",
        "CoreServices",
        "-o",
        ctx.output,
        ...objects,
      ]);
      await rm(objDir, { recursive: true });
    },
  }),
  updates: {
    none: "built from this checkout's patched @parcel/watcher; moves with the npm updater's bump of the package and its patch",
  },
});
