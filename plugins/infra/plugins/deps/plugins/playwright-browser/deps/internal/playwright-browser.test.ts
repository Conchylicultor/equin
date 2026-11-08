import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  defineDep,
  ensureDep,
  readyNow,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { BROWSER_EXECUTABLES_FILE } from "../../core";
import {
  launchChromium,
  playwrightBrowser,
  resolvePlaywright,
} from "./playwright-browser";

// A fake checkout: this plugin's directory under it, and a fake `playwright`
// (+ its nested `playwright-core`) where module resolution from that directory
// finds them. The fake CLI "installs" by creating one file per executable in
// PLAYWRIGHT_BROWSERS_PATH, and the fake registry reports those files — so the
// whole install path runs with no network.
const KIND_REL = relative(REPO_ROOT, resolve(import.meta.dir, "../.."));

let base: AppPath;
let root: AppPath;
let store: { cacheRoot: AppPath; locksRoot: AppPath };
const exec = execContextForTests();

function writeFakePlaywright(coreVersion: string): void {
  const pw = join(root, "node_modules", "playwright");
  const core = join(pw, "node_modules", "playwright-core");
  mkdirSync(join(core, "lib"), { recursive: true });
  writeFileSync(
    join(pw, "package.json"),
    JSON.stringify({ name: "playwright", bin: { playwright: "cli.js" } }),
  );
  writeFileSync(
    join(pw, "cli.js"),
    [
      `const { mkdirSync, writeFileSync } = require("node:fs");`,
      `const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;`,
      `if (process.argv[2] !== "install" || process.argv[3] !== "chromium") process.exit(3);`,
      `mkdirSync(dir, { recursive: true });`,
      `for (const f of ["chromium", "chromium-headless-shell"]) writeFileSync(dir + "/" + f, "");`,
    ].join("\n"),
  );
  writeFileSync(
    join(core, "package.json"),
    JSON.stringify({
      name: "playwright-core",
      version: coreVersion,
      exports: {
        "./package.json": "./package.json",
        "./lib/coreBundle": "./lib/coreBundle.js",
      },
    }),
  );
  writeFileSync(
    join(core, "lib", "coreBundle.js"),
    [
      `const { join } = require("node:path");`,
      `module.exports = { registry: { registry: { findExecutable: (name) => ({`,
      `  executablePath: () => join(process.env.PLAYWRIGHT_BROWSERS_PATH, name),`,
      `}) } } };`,
    ].join("\n"),
  );
}

beforeEach(() => {
  base = asAppPath(
    mkdtempSync(join(tmpdir(), "deps-playwright-browser-test-")),
  );
  root = joinAppPath(base, "repo");
  store = {
    cacheRoot: joinAppPath(base, "cache"),
    locksRoot: joinAppPath(base, "locks"),
  };
  mkdirSync(join(root, KIND_REL), { recursive: true });
  writeFakePlaywright("1.2.3");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const chromium = defineDep({
  id: "chromium-test",
  owner: "infra/deps/playwright-browser",
  description: "",
  sizeHint: "",
  source: playwrightBrowser({ browser: "chromium" }),
  updates: { none: "follows the playwright npm pin" },
});

describe("playwrightBrowser", () => {
  test("the identity is a function of the playwright-core version resolved from the checkout", async () => {
    expect((await resolvePlaywright(root)).coreVersion).toBe("1.2.3");
    const inputs = await chromium.source.identityInputs(root);
    expect(inputs.playwrightCore).toBe("1.2.3");
    expect(inputs.browser).toBe("chromium");

    const first = await readyNow(chromium, { store, root });
    await ensureDep(chromium, exec, { store, root });
    writeFakePlaywright("1.2.4");
    // A new playwright-core is a new identity: nothing installed there yet.
    expect((await readyNow(chromium, { store, root })).kind).toBe("absent");
    expect(first.kind).toBe("absent");
    expect((await chromium.source.identityInputs(root)).playwrightCore).toBe(
      "1.2.4",
    );
  });

  test("installs into its own env/ and records the executables Playwright reports", async () => {
    const ready = await ensureDep(chromium, exec, { store, root });
    const recorded = JSON.parse(
      readFileSync(join(ready.dir, BROWSER_EXECUTABLES_FILE), "utf8"),
    ) as Record<string, string>;
    expect(recorded).toEqual({
      playwrightCore: "1.2.3",
      headed: join(ready.dir, "chromium"),
      headlessShell: join(ready.dir, "chromium-headless-shell"),
    });
    expect((await readyNow(chromium, { store, root })).kind).toBe("ready");
  });

  test("an install missing either executable is not intact, so reads absent", async () => {
    const ready = await ensureDep(chromium, exec, { store, root });
    rmSync(join(ready.dir, "chromium-headless-shell"));
    expect(await chromium.source.isIntact?.(ready.dir)).toBe(false);
    expect((await readyNow(chromium, { store, root })).kind).toBe("absent");

    // Reinstalled, and the headed one going missing counts the same.
    const again = await ensureDep(chromium, exec, { store, root });
    rmSync(join(again.dir, "chromium"));
    expect(await chromium.source.isIntact?.(again.dir)).toBe(false);
  });

  test("launchChromium takes a Ready, never a bare dependency", () => {
    const launch = (r: Ready<typeof chromium.source>) => launchChromium(r);
    // @ts-expect-error — launching without ensuring does not compile.
    const unensured = () => launchChromium(chromium);
    expect(typeof launch).toBe("function");
    expect(typeof unensured).toBe("function");
  });
});
