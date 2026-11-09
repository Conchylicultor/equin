import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
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

let dir: AppPath;
let bundle: AppPath;
let calls: string[];
let signed: boolean;
let failSign: boolean;
let running: () => string[];

beforeEach(() => {
  // Real: running executables are reported by real path (/private/var/…).
  dir = asAppPath(realpathSync(mkdtempSync(join(tmpdir(), "macos-app-"))));
  bundle = joinAppPath(dir, "state", "equin.app");
  mkdirSync(join(dir, "state"));
  calls = [];
  signed = true;
  failSign = false;
  running = () => [];
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
    signer: async () => null,
    register: async (path) => {
      calls.push(`register ${path}`);
    },
    executablesInUse: async () => {
      calls.push("lsof");
      return running();
    },
  };
}

function build(name: string, content: string, icon?: string) {
  const file = joinAppPath(dir, "builds", name, content);
  mkdirSync(join(dir, "builds", name), { recursive: true });
  writeFileSync(file, content);
  let iconPath: AppPath | undefined;
  if (icon !== undefined) {
    iconPath = joinAppPath(dir, "builds", name, "icon.icns");
    writeFileSync(iconPath, icon);
  }
  return {
    file,
    identity: `${name}-dep@${content}`,
    ...(iconPath === undefined ? {} : { icon: iconPath }),
  };
}

const gateway = { name: "gateway" };
const tray = { name: "equin-desktop", main: true };
const exe = (name: string) => joinAppPath(bundle, "Contents", "MacOS", name);
/** The swapped-out bundles beside the installed one. */
const oldBundles = () =>
  readdirSync(joinAppPath(dir, "state"))
    .filter((name) => name.startsWith("equin.app.old-"))
    .map((name) => joinAppPath(dir, "state", name));
const plist = () =>
  readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");

describe("Info.plist", () => {
  const components: InstalledComponent[] = [
    { name: "gateway", identity: "gw@1", main: false, icon: false },
    {
      name: "equin-desktop",
      identity: "mb@1",
      main: true,
      icon: true,
      urlSchemes: ["equin"],
    },
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

  test("registers every component's URL schemes, and none when none declares one", () => {
    expect(renderAppInfoPlist(components)).toContain(
      `<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>${APP_BUNDLE_ID}</string><key>CFBundleURLSchemes</key><array><string>equin</string></array></dict></array>`,
    );
    expect(renderAppInfoPlist([components[0]!])).not.toContain(
      "CFBundleURLTypes",
    );
  });

  test("a record from before URL schemes reads back as declaring none", () => {
    const old = renderAppInfoPlist([components[0]!]);
    expect(readAppComponents(old)).toEqual([components[0]!]);
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
    expect(await installedAppComponents(bundle)).toEqual([
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
    expect((await installedAppComponents(bundle))?.map((c) => c.name)).toEqual([
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
    expect(calls).toEqual(["lock", "sign", `register ${bundle}`, "lsof"]);
  });

  test("the same build, a new URL scheme: the plist is rewritten and registered", async () => {
    await installServiceExecutable(host(), tray, build("mb", "1"), () => {});
    calls = [];
    await installServiceExecutable(
      host(),
      { ...tray, urlSchemes: ["equin"] },
      build("mb", "1"),
      () => {},
    );
    expect(calls).toEqual(["lock", "sign", `register ${bundle}`, "lsof"]);
    expect(plist()).toContain(
      "<key>CFBundleURLSchemes</key><array><string>equin</string></array>",
    );
  });

  test("a new build replaces the executable", async () => {
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    await installServiceExecutable(host(), gateway, build("gw", "2"), () => {});
    expect(readFileSync(exe("gateway"), "utf8")).toBe("2");
    expect((await installedAppComponents(bundle))?.[0]?.identity).toBe(
      "gw-dep@2",
    );
  });

  test("the swapped-out bundle is kept while a process runs from it, then removed", async () => {
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    // The gateway keeps running the file it was started from, which the next
    // swap renames into the first old copy.
    let startedFrom: string | undefined;
    running = () => {
      startedFrom ??= join(oldBundles()[0]!, "Contents", "MacOS", "gateway");
      return ["/usr/lib/dyld", startedFrom];
    };
    await installServiceExecutable(host(), tray, build("mb", "1"), () => {});
    const old = oldBundles();
    expect(old).toHaveLength(1);
    expect(readFileSync(startedFrom!, "utf8")).toBe("1");

    // Another swap: only the copy in use is kept.
    await installServiceExecutable(host(), tray, build("mb", "2"), () => {});
    expect(oldBundles()).toEqual(old);
    // A no-op install sweeps too.
    await installServiceExecutable(host(), tray, build("mb", "2"), () => {});
    expect(oldBundles()).toEqual(old);

    // The gateway restarted from the new bundle: the next install removes it.
    running = () => [exe("gateway")];
    await installServiceExecutable(host(), tray, build("mb", "2"), () => {});
    expect(readdirSync(join(dir, "state"))).toEqual(["equin.app"]);
  });

  test("a swap whose old bundle nothing runs leaves none behind", async () => {
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    calls = [];
    await installServiceExecutable(host(), gateway, build("gw", "2"), () => {});
    expect(calls).toEqual(["lock", "sign", `register ${bundle}`, "lsof"]);
    expect(readdirSync(join(dir, "state"))).toEqual(["equin.app"]);
  });

  test("a failed signature leaves the installed bundle as it was", async () => {
    await installServiceExecutable(host(), gateway, build("gw", "1"), () => {});
    failSign = true;
    expect(
      installServiceExecutable(host(), gateway, build("gw", "2"), () => {}),
    ).rejects.toMatchObject({ message: "signing failed" });

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
