import { mkdir } from "node:fs/promises";
import { readFile, realpath } from "@plugins/packages/plugins/timed-fs/core";
import { dirname, join, relative, resolve } from "node:path";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  LaunchOptions,
} from "playwright";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import type {
  DepSource,
  InstallContext,
  Ready,
} from "@plugins/infra/plugins/deps/deps";
import { BROWSER_EXECUTABLES_FILE, readBrowserExecutables } from "../../core";

/** The browsers this kind installs. Only Chromium has a user today. */
export type PlaywrightBrowserName = "chromium";

/** A browser build Playwright pins, installed into the deps cache. */
export interface PlaywrightBrowserSource extends DepSource<"playwright-browser"> {
  readonly browser: PlaywrightBrowserName;
}

const MINUTE = 60_000;

/**
 * Ceiling on `playwright install`: a hung download must end as a failed
 * install (recorded, visible), never as an install that never ends.
 */
const INSTALL_TIMEOUT_MS = 15 * MINUTE;

/**
 * This plugin's directory, relative to the checkout it lives in. Playwright is
 * resolved from HERE in whichever checkout is asked (`root`), because
 * `launchChromium` below imports `playwright` from here: installer, identity
 * and launcher then walk one module graph and cannot disagree about which
 * version is meant.
 */
const KIND_REL = relative(REPO_ROOT, resolve(import.meta.dir, "../.."));

interface ResolvedPlaywright {
  /** `playwright`'s own CLI entry point, per its `bin` field. */
  cli: string;
  /**
   * `playwright-core`'s version — not `playwright`'s: core pins the browser
   * revision, so core is what the installed bytes are a function of.
   */
  coreVersion: string;
  /** `playwright-core/lib/coreBundle`, whose registry reports the executables. */
  coreBundle: string;
}

/**
 * The real directory of package `name` as module resolution from `from` finds
 * it: the first `node_modules/<name>/package.json` walking up from `from`,
 * symlinks resolved (bun's isolated store links each package in, and a
 * package's own dependencies sit beside its real directory). Async: this runs
 * on a backend's thread, and `Bun.resolveSync` stats its way up the same chain
 * synchronously — a 4.4 s stall on main (Bun documents its async
 * `Bun.resolve` as the same work).
 */
async function resolvePackageDir(name: string, from: string): Promise<string> {
  for (let dir = from; ; dir = dirname(dir)) {
    try {
      return dirname(
        await realpath(join(dir, "node_modules", name, "package.json")),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
    if (dirname(dir) === dir)
      throw new Error(`Cannot find package '${name}' from ${from}`);
  }
}

/**
 * Resolve the workspace's own Playwright through the module graph of this
 * plugin in `root` — the `node_modules` walk `import("playwright")` does
 * (`resolvePackageDir`), and `playwright-core`'s `exports` map for its
 * registry bundle. Never a package-runner spelling (`bunx`/`npx`): one of
 * those resolves outside the workspace and can fall back to registry
 * `latest`, installing a revision nothing here launches
 * (`e2e-harness:pinned-playwright-invocation` keeps them out of the tree).
 *
 * Throws when it cannot be resolved: the identity is then underivable and the
 * dependency reads `failed`, never `absent`.
 */
export async function resolvePlaywright(
  root: string,
): Promise<ResolvedPlaywright> {
  const pkgDir = await resolvePackageDir("playwright", join(root, KIND_REL));
  const pkgPath = join(pkgDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    bin?: { playwright?: string };
  };
  const bin = pkg.bin?.playwright;
  if (!bin) {
    throw new Error(
      `${pkgPath} declares no \`bin.playwright\` — cannot locate the Playwright CLI to install a browser with.`,
    );
  }
  // playwright-core is playwright's own nested dependency, so it is resolved
  // from playwright's directory, not from the repo root.
  const coreDir = await resolvePackageDir("playwright-core", pkgDir);
  const corePkgPath = join(coreDir, "package.json");
  const core = JSON.parse(await readFile(corePkgPath, "utf8")) as {
    version?: string;
    exports?: Record<string, unknown>;
  };
  if (!core.version) {
    throw new Error(`${corePkgPath} declares no \`version\`.`);
  }
  const coreBundle = core.exports?.["./lib/coreBundle"];
  if (typeof coreBundle !== "string") {
    throw new Error(
      `${corePkgPath} exports no \`./lib/coreBundle\` file — cannot ask Playwright's registry for the executables.`,
    );
  }
  return {
    cli: join(pkgDir, bin),
    coreVersion: core.version,
    coreBundle: join(coreDir, coreBundle),
  };
}

/**
 * The child that records the executables (`scripts/record-executables.ts`,
 * run by path). It asks Playwright's own registry — with
 * `PLAYWRIGHT_BROWSERS_PATH` set to the install's dir — for the headed and
 * headless-shell executables, and writes what it answers. A child, not this
 * process: the registry fixes its browsers path when it is first loaded, and
 * this process may already have loaded it with another one.
 */
const RECORD_EXECUTABLES = resolve(
  import.meta.dir,
  "../../scripts/record-executables.ts",
);

/**
 * The installer kind for a browser build Playwright pins.
 *
 * - **Identity**: the `playwright-core` version resolved through this plugin's
 *   module graph (the same graph `launchChromium` imports from), plus the
 *   browser and the platform. Bumping the `playwright` pin is a new identity, so
 *   a new install beside the old one; the deps sweep reclaims the old one.
 * - **Install**: `<bun> <playwright cli> install chromium` with
 *   `PLAYWRIGHT_BROWSERS_PATH` = the install's `env/` (its progress lands in the
 *   install log), then a one-line child records the executables Playwright
 *   reports for that path in `env/executables.json`. The shared
 *   `~/Library/Caches/ms-playwright` is never touched.
 * - **Intact**: both recorded executables exist, so a payload deleted by hand
 *   reads as absent and is installed again.
 * - **Staying current**: no updater of its own. It follows the `playwright`
 *   npm pin; the declaration says so in `updates: { none }`.
 */
export function playwrightBrowser(opts: {
  browser: PlaywrightBrowserName;
}): PlaywrightBrowserSource {
  const { browser } = opts;
  return {
    kind: "playwright-browser",
    label: `${browser}, at the revision this checkout's playwright-core pins`,
    browser,

    async identityInputs(root) {
      const { coreVersion } = await resolvePlaywright(root);
      return {
        browser,
        playwrightCore: coreVersion,
        platform: `${process.platform}/${process.arch}`,
      };
    },

    async install(ctx: InstallContext) {
      const pw = await resolvePlaywright(ctx.root);
      await mkdir(ctx.dir, { recursive: true });
      // The installer's own env, pointed at this install. `process.execPath`
      // + the resolved CLI, never a package runner: see `resolvePlaywright`.
      const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: ctx.dir };
      await ctx.run([process.execPath, pw.cli, "install", browser], {
        cwd: ctx.root,
        env,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      await ctx.run(
        [
          process.execPath,
          RECORD_EXECUTABLES,
          pw.coreBundle,
          join(ctx.dir, BROWSER_EXECUTABLES_FILE),
          pw.coreVersion,
        ],
        { cwd: ctx.root, env, timeoutMs: MINUTE },
      );
      // Playwright answered success; now hold it to what it reported.
      const read = await readBrowserExecutables(ctx.dir);
      if (!read.ok) {
        throw new Error(
          `playwright install ${browser} finished, but ${read.reason}`,
        );
      }
      ctx.log(
        `${browser}: headless shell ${read.executables.headlessShell}, headed ${read.executables.headed}`,
      );
      await assertSystemLibraries(read.executables.headlessShell, pw.cli);
    },

    isIntact: async (dir) => (await readBrowserExecutables(dir)).ok,
  };
}

/**
 * Linux: the browser links against system libraries (NSS, ATK, libgbm, ALSA, …)
 * that a server image does not ship and Playwright does not download. Without
 * them every launch fails, minutes later and inside whatever check or script
 * launched it. So the install is not ready until the dynamic linker resolves
 * every one, and its failure names the one root command that installs them.
 * macOS ships everything the browser links against.
 */
async function assertSystemLibraries(
  binary: string,
  cli: string,
): Promise<void> {
  if (process.platform !== "linux") return;
  const { stdout } = await spawnExpectOk(["ldd", binary], {
    timeoutMs: MINUTE,
  });
  const missing = stdout
    .split("\n")
    .filter((l) => l.includes("=> not found"))
    .map((l) => l.trim().split(" ")[0]);
  if (missing.length > 0) {
    throw new Error(
      `the browser cannot start on this host: system libraries missing (${missing.join(", ")}). Install them once, as root: sudo ${process.execPath} ${cli} install-deps chromium`,
    );
  }
}

/** `chromium.launch` options, minus the two that pick the binary: the install does. */
export type ChromiumLaunchOptions = Omit<
  LaunchOptions,
  "executablePath" | "channel"
> & {
  /**
   * Render with the machine's GPU instead of the software rasterizer headless
   * Chromium falls back to (SwiftShader). Some pages refuse to draw without
   * hardware WebGL: Google Maps silently falls back from a vector map to a
   * raster one. Measured on macOS: `--enable-gpu` alone makes the headless
   * shell use ANGLE on Metal (`--use-angle=metal` is then implied, and
   * `--ignore-gpu-blocklist` changes nothing). Off by default — a GPU frame is
   * the machine's, not a portable pixel baseline.
   */
  gpu?: boolean;
};

/** The Chromium switches `gpu: true` adds. */
const GPU_ARGS = ["--enable-gpu"] as const;

/**
 * Launch the installed Chromium. Taking a `Ready` makes "launched without
 * ensuring" a type error.
 *
 * Headless (the default) runs the recorded `chrome-headless-shell`; `headless:
 * false` runs the recorded headed binary — the pair Playwright itself would
 * pick for each mode. `playwright` is imported here, lazily (seconds of module
 * evaluation nobody should pay at boot), from the same module graph the
 * identity was resolved through.
 */
export async function launchChromium(
  ready: Ready<PlaywrightBrowserSource>,
  opts: ChromiumLaunchOptions = {},
): Promise<Browser> {
  const read = await readBrowserExecutables(ready.dir);
  if (!read.ok) {
    throw new Error(
      `${ready.dep.id} is no longer intact (${read.reason}) — reinstall it: ./equin deps install ${ready.dep.id}`,
    );
  }
  const { gpu = false, ...launch } = opts;
  const headless = launch.headless ?? true;
  const { chromium } = await import("playwright");
  return chromium.launch({
    ...launch,
    args: [...(launch.args ?? []), ...(gpu ? GPU_ARGS : [])],
    headless,
    executablePath: headless
      ? read.executables.headlessShell
      : read.executables.headed,
  });
}

/** `chromium.launchPersistentContext` options, minus the two that pick the binary. */
export type PersistentChromiumLaunchOptions = Omit<
  NonNullable<Parameters<BrowserType["launchPersistentContext"]>[1]>,
  "executablePath" | "channel"
> & {
  /**
   * Launch a binary DERIVED from the installed one rather than the installed
   * one itself — e.g. a copy of the headed app bundle re-flagged for the OS.
   * Takes the installed executable's path (the one `headless` picks) and
   * returns the path to launch; the install stays the only source.
   */
  derive?: (executable: string) => Promise<string>;
};

/**
 * Launch the installed Chromium on a persistent profile (`userDataDir`):
 * cookies, logins and storage survive the process. The same binary choice as
 * {@link launchChromium} (headless shell by default, the headed binary with
 * `headless: false`). The browser is the returned context's — closing the
 * context closes it and flushes the profile.
 */
export async function launchPersistentChromium(
  ready: Ready<PlaywrightBrowserSource>,
  userDataDir: string,
  opts: PersistentChromiumLaunchOptions = {},
): Promise<BrowserContext> {
  const read = await readBrowserExecutables(ready.dir);
  if (!read.ok) {
    throw new Error(
      `${ready.dep.id} is no longer intact (${read.reason}) — reinstall it: ./equin deps install ${ready.dep.id}`,
    );
  }
  const { derive, ...launchOpts } = opts;
  const headless = launchOpts.headless ?? true;
  const installed = headless
    ? read.executables.headlessShell
    : read.executables.headed;
  const executablePath = derive ? await derive(installed) : installed;
  const { chromium } = await import("playwright");
  return chromium.launchPersistentContext(userDataDir, {
    ...launchOpts,
    headless,
    executablePath,
  });
}

/**
 * Connect to a Chromium another process launched and bound (`browser.bind()`,
 * a pipe path) — the agent browser's shared one. Nothing is installed or
 * launched here: the binder's install runs it. `close()` on the result drops
 * this connection only; the browser and the pages it holds stay up.
 */
export async function connectChromium(endpoint: string): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.connect(endpoint);
}
