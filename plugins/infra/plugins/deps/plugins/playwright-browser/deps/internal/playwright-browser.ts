import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Browser, LaunchOptions } from "playwright";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
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
 * Resolve the workspace's own Playwright through the module graph of this
 * plugin in `root` — `Bun.resolveSync`, exactly as `import("playwright")`
 * resolves. Never a package-runner spelling (`bunx`/`npx`): one of those
 * resolves outside the workspace and can fall back to registry `latest`,
 * installing a revision nothing here launches
 * (`e2e-harness:pinned-playwright-invocation` keeps them out of the tree).
 *
 * Throws when it cannot be resolved: the identity is then underivable and the
 * dependency reads `failed`, never `absent`.
 */
export function resolvePlaywright(root: string): ResolvedPlaywright {
  const from = join(root, KIND_REL);
  const pkgPath = Bun.resolveSync("playwright/package.json", from);
  const pkgDir = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
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
  const corePkgPath = Bun.resolveSync("playwright-core/package.json", pkgDir);
  const core = JSON.parse(readFileSync(corePkgPath, "utf8")) as {
    version?: string;
  };
  if (!core.version) {
    throw new Error(`${corePkgPath} declares no \`version\`.`);
  }
  return {
    cli: join(pkgDir, bin),
    coreVersion: core.version,
    coreBundle: Bun.resolveSync("playwright-core/lib/coreBundle", pkgDir),
  };
}

/**
 * The one-line child that records the executables. It asks Playwright's own
 * registry — with `PLAYWRIGHT_BROWSERS_PATH` set to the install's dir — for the
 * headed and headless-shell executables, and writes what it answers. A child,
 * not this process: the registry fixes its browsers path when it is first
 * loaded, and this process may already have loaded it with another one.
 */
const RECORD_EXECUTABLES =
  `const [, b, out, v] = process.argv; const r = require(b).registry.registry; ` +
  `require("node:fs").writeFileSync(out, JSON.stringify({ playwrightCore: v, ` +
  `headed: r.findExecutable("chromium").executablePath(), ` +
  `headlessShell: r.findExecutable("chromium-headless-shell").executablePath() }));`;

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
      const { coreVersion } = resolvePlaywright(root);
      return {
        browser,
        playwrightCore: coreVersion,
        platform: `${process.platform}/${process.arch}`,
      };
    },

    async install(ctx: InstallContext) {
      const pw = resolvePlaywright(ctx.root);
      mkdirSync(ctx.dir, { recursive: true });
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
          "-e",
          RECORD_EXECUTABLES,
          pw.coreBundle,
          join(ctx.dir, BROWSER_EXECUTABLES_FILE),
          pw.coreVersion,
        ],
        { cwd: ctx.root, env, timeoutMs: MINUTE },
      );
      // Playwright answered success; now hold it to what it reported.
      const read = readBrowserExecutables(ctx.dir);
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

    isIntact: (dir) => readBrowserExecutables(dir).ok,
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
>;

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
  const read = readBrowserExecutables(ready.dir);
  if (!read.ok) {
    throw new Error(
      `${ready.dep.id} is no longer intact (${read.reason}) — reinstall it: ./singularity deps install ${ready.dep.id}`,
    );
  }
  const headless = opts.headless ?? true;
  const { chromium } = await import("playwright");
  return chromium.launch({
    ...opts,
    headless,
    executablePath: headless
      ? read.executables.headlessShell
      : read.executables.headed,
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
