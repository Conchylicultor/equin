import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleOfExecutable,
  installedAppComponents,
  installServiceExecutable,
  plannedServiceExecutable,
  type MacosAppHost,
} from "./macos-app";
import {
  APP_BUNDLE_ID,
  mainComponent,
  readAppComponents,
  renderAppInfoPlist,
  type InstalledComponent,
} from "./macos-app-plist";

let dir: string;
let bundle: string;
let calls: string[];
let signed: boolean;
let failSign: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "macos-app-"));
  bundle = join(dir, "state", "equin.app");
  mkdirSync(join(dir, "state"));
  calls = [];
  signed = true;
  failSign = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function host(): MacosAppHost {
  return {
    platform: "darwin",
    bundle,
    withLock: async (fn) => {
      calls.push("lock");
      return fn();
    },
    sign: async (staging) => {
      calls.push("sign");
      // The staging copy is what gets signed, never the installed bundle.
      expect(staging).not.toBe(bundle);
      expect(existsSync(join(staging, "Contents", "Info.plist"))).toBe(true);
      if (failSign) throw new Error("signing failed");
    },
    isSigned: async () => signed,
    register: async (path) => {
      calls.push(`register ${path}`);
    },
  };
}

function build(name: string, content: string, icon?: string) {
  const file = join(dir, "builds", name, content);
  mkdirSync(join(dir, "builds", name), { recursive: true });
  writeFileSync(file, content);
  let iconPath: string | undefined;
  if (icon !== undefined) {
    iconPath = join(dir, "builds", name, "icon.icns");
    writeFileSync(iconPath, icon);
  }
  return {
    file,
    identity: `${name}-dep@${content}`,
    ...(iconPath === undefined ? {} : { icon: iconPath }),
  };
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const gateway = { name: "gateway" };
const tray = { name: "equin-desktop", main: true };
const exe = (name: string) => join(bundle, "Contents", "MacOS", name);
const plist = () =>
  readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");

describe("Info.plist", () => {
  const components: InstalledComponent[] = [
    { name: "gateway", identity: "gw@1", main: false, icon: false },
    { name: "equin-desktop", identity: "mb@1", main: true, icon: true },
  ];

  test("round-trips the components, sorted by name", () => {
    expect(readAppComponents(renderAppInfoPlist(components))).toEqual([
      components[1]!,
      components[0]!,
    ]);
  });

  test("names the app equin, dev.equin, its main component and its icon", () => {
    const text = renderAppInfoPlist(components);
    expect(text).toContain(
      `<key>CFBundleIdentifier</key><string>${APP_BUNDLE_ID}</string>`,
    );
    expect(text).toContain(
      "<key>CFBundleDisplayName</key><string>equin</string>",
    );
    expect(text).toContain(
      "<key>CFBundleExecutable</key><string>equin-desktop</string>",
    );
    expect(text).toContain("<key>CFBundleIconFile</key><string>equin</string>");
    expect(text).toContain("<key>LSUIElement</key><true/>");
  });

  test("another component stands in as main until the main one is installed", () => {
    expect(mainComponent([components[0]!]).name).toBe("gateway");
    expect(mainComponent(components).name).toBe("equin-desktop");
  });

  test("a plist it did not write is not read as one", () => {
    expect(
      readAppComponents(
        renderAppInfoPlist(components).replace(APP_BUNDLE_ID, "dev.other"),
      ),
    ).toBeNull();
  });
});

describe("plannedServiceExecutable", () => {
  test("macOS: inside the bundle, the build named", () => {
    expect(plannedServiceExecutable(host(), gateway, build("gw", "1"))).toEqual(
      { path: exe("gateway"), identity: "gw-dep@1", bundled: true },
    );
  });

  test("elsewhere: the build itself", () => {
    const b = build("gw", "1");
    expect(
      plannedServiceExecutable({ ...host(), platform: "linux" }, gateway, b),
    ).toEqual({ path: b.file, identity: b.identity, bundled: false });
  });
});

describe("installServiceExecutable", () => {
  test("installs a component into a new bundle, signed and registered", async () => {
    const out = await installServiceExecutable(
      host(),
      gateway,
      build("gw", "1"),
      () => {},
    );
    expect(out).toEqual({
      path: exe("gateway"),
      identity: "gw-dep@1",
      bundled: true,
    });
    expect(readFileSync(exe("gateway"), "utf8")).toBe("1");
    expect(installedAppComponents(bundle)).toEqual([
      { name: "gateway", identity: "gw-dep@1", main: false, icon: false },
    ]);
    expect(calls).toEqual(["lock", "sign", `register ${bundle}`]);
    // No staging or old copy is left beside it.
    expect(readdirSync(join(dir, "state"))).toEqual(["equin.app"]);
  });

  test("a second component joins the first, which keeps its build", async () => {
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    await installServiceExecutable(
      host(),
      tray,
      build("mb", "1", "ICON"),
      () => {},
    );
    expect(readFileSync(exe("gateway"), "utf8")).toBe("1");
    expect(readFileSync(exe("equin-desktop"), "utf8")).toBe("1");
    expect(
      readFileSync(join(bundle, "Contents", "Resources", "equin.icns"), "utf8"),
    ).toBe("ICON");
    expect(plist()).toContain(
      "<key>CFBundleExecutable</key><string>equin-desktop</string>",
    );
    expect(installedAppComponents(bundle)?.map((c) => c.name)).toEqual([
      "equin-desktop",
      "gateway",
    ]);
  });

  test("the same build, signed: nothing is rewritten", async () => {
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    calls = [];
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    expect(calls).toEqual(["lock"]);
  });

  test("the same build, no longer signed by this machine: re-signed", async () => {
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    calls = [];
    signed = false;
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    expect(calls).toEqual(["lock", "sign", `register ${bundle}`]);
  });

  test("a new build replaces the executable", async () => {
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    await installServiceExecutable(host(), gateway, build("gw", "2"), () => {});
    expect(readFileSync(exe("gateway"), "utf8")).toBe("2");
    expect(installedAppComponents(bundle)?.[0]?.identity).toBe("gw-dep@2");
  });

  test("a failed signature leaves the installed bundle as it was", async () => {
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    failSign = true;
    const err = await rejection(
      installServiceExecutable(host(), gateway, build("gw", "2"), () => {}),
    );
    expect(err.message).toBe("signing failed");
    expect(readFileSync(exe("gateway"), "utf8")).toBe("1");
    expect(readdirSync(join(dir, "state"))).toEqual(["equin.app"]);
  });

  test("a bundle it did not write is rebuilt, not merged into", async () => {
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(bundle, "Contents", "MacOS", "stranger"), "x");
    writeFileSync(join(bundle, "Contents", "Info.plist"), "<plist/>");
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    expect(existsSync(exe("stranger"))).toBe(false);
    expect(readFileSync(exe("gateway"), "utf8")).toBe("1");
  });

  test("off macOS: the build, untouched", async () => {
    const b = build("gw", "1");
    const out = await installServiceExecutable(
      { ...host(), platform: "linux" },
      gateway,
      b,
      () => {},
    );
    expect(out).toEqual({ path: b.file, identity: b.identity, bundled: false });
    expect(calls).toEqual([]);
    expect(existsSync(bundle)).toBe(false);
  });
});

test("bundleOfExecutable", () => {
  expect(bundleOfExecutable(bundle, exe("gateway"))).toBe(bundle);
  expect(
    bundleOfExecutable(bundle, "/cache/gateway-binary/x/env/gateway"),
  ).toBe(null);
});
