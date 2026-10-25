import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultShimRoots,
  dockFileUrl,
  type ShimApp,
  type ShimPlatform,
} from "./shim-files";
import {
  pinShim,
  readInstalledAppIds,
  readPinnedAppIds,
  syncShims,
  syncStableHelper,
  writeShim,
  type ShimHost,
} from "./shim-host";

// Every shim is written under a fresh /tmp home with a fake command runner:
// `cp` copies, `iconutil` writes a stand-in .icns, `defaults` / `gsettings`
// answer from a fixture — nothing reaches the real ~/Applications, Dock or
// dconf.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "menu-bar-shims-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function app(id: string, name: string): ShimApp {
  return {
    id,
    name,
    url: `http://equin.localhost:9000/${id}`,
    namespace: MAIN_WORKTREE_NAME,
    iconSvg: `<svg>${id}</svg>`,
  };
}

function fakeHost(
  platform: ShimPlatform,
  answers: Record<string, string> = {},
): ShimHost & { calls: string[][]; icons: number[] } {
  const calls: string[][] = [];
  const icons: number[] = [];
  return {
    platform,
    roots: defaultShimRoots(join(root, "home")),
    calls,
    icons,
    iconPng: (appId, size) => {
      icons.push(size);
      return new TextEncoder().encode(`png:${appId}:${size}`);
    },
    run: async (argv) => {
      calls.push([...argv]);
      const [cmd] = argv;
      if (cmd === "cp") copyFileSync(argv[2]!, argv[3]!);
      if (cmd === "iconutil") writeFileSync(argv[5]!, "icns");
      return answers[argv.join(" ")] ?? "";
    },
  };
}

function helperBinary(content = "helper-v1"): string {
  const p = join(root, "helper-src");
  writeFileSync(p, content);
  return p;
}

describe("macOS shim layout", () => {
  test("writes the bundle: clone, plist, icns, ad-hoc signature", async () => {
    const host = fakeHost("macos");
    const helper = helperBinary();
    await writeShim(host, app("mail", "Mail"), helper);
    const bundle = join(root, "home", "Applications", "equin Mail.app");
    expect(
      readFileSync(join(bundle, "Contents", "MacOS", "equin-desktop"), "utf-8"),
    ).toBe("helper-v1");
    expect(
      readFileSync(join(bundle, "Contents", "Info.plist"), "utf-8"),
    ).toContain("<key>EquinAppId</key><string>mail</string>");
    expect(existsSync(join(bundle, "Contents", "Resources", "app.icns"))).toBe(
      true,
    );
    expect(existsSync(`${bundle}.staging`)).toBe(false);
    // The helper is an APFS clone; the bundle is signed as assembled.
    expect(host.calls[0]![0]).toBe("cp");
    expect(host.calls[0]![1]).toBe("-c");
    const sign = host.calls.find((c) => c[0] === "codesign")!;
    expect(sign).toEqual([
      "codesign",
      "--force",
      "--sign",
      "-",
      `${bundle}.staging`,
    ]);
    // Every iconset member is rendered at its own size, in-process — no
    // `sips` (ten runs of it took ~2 s); `iconutil` only packs them.
    expect(host.icons).toContain(16);
    expect(host.icons).toContain(1024);
    expect(host.icons).toHaveLength(10);
    expect(host.calls.map((c) => c[0])).toEqual(["cp", "iconutil", "codesign"]);
    expect(readInstalledAppIds(host)).toEqual(["mail"]);
  });

  test("a failed step leaves no half-written bundle", async () => {
    const host = fakeHost("macos");
    const failing: ShimHost = {
      ...host,
      run: async (argv) => {
        if (argv[0] === "codesign") throw new Error("codesign failed");
        return host.run(argv);
      },
    };
    const failure = await writeShim(
      failing,
      app("mail", "Mail"),
      helperBinary(),
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("codesign failed");
    expect(readInstalledAppIds(host)).toEqual([]);
    expect(
      existsSync(join(root, "home", "Applications", "equin Mail.app.staging")),
    ).toBe(false);
  });

  test("ignores bundles that are not equin shims", async () => {
    const host = fakeHost("macos");
    const other = join(root, "home", "Applications", "equin Fake.app");
    mkdirSync(join(other, "Contents"), { recursive: true });
    writeFileSync(join(other, "Contents", "Info.plist"), "<plist/>");
    mkdirSync(join(root, "home", "Applications", "Safari.app"));
    expect(readInstalledAppIds(host)).toEqual([]);
  });

  test("pins to the Dock once", async () => {
    const host = fakeHost("macos", {
      "defaults read com.apple.dock persistent-apps": "(\n)",
    });
    await pinShim(host, app("mail", "Mail"));
    expect(host.calls.map((c) => c[0])).toEqual([
      "defaults",
      "defaults",
      "killall",
    ]);
  });
});

describe("Linux shim layout", () => {
  test("writes the icon and the desktop entry", async () => {
    const host = fakeHost("linux");
    await writeShim(host, app("mail", "Mail"), "/stable/equin-desktop");
    const share = join(root, "home", ".local", "share");
    const desktop = readFileSync(
      join(share, "applications", "equin-mail.desktop"),
      "utf-8",
    );
    expect(desktop).toContain(
      "Exec=/stable/equin-desktop window --app mail --url http://equin.localhost:9000/mail",
    );
    expect(
      readFileSync(
        join(share, "icons", "hicolor", "512x512", "apps", "equin-mail.png"),
        "utf-8",
      ),
    ).toBe("png:mail:512");
    expect(host.calls).toEqual([]);
    expect(readInstalledAppIds(host)).toEqual(["mail"]);
  });

  test("pins to the GNOME dash", async () => {
    const host = fakeHost("linux", {
      "gsettings get org.gnome.shell favorite-apps": "['firefox.desktop']\n",
    });
    await pinShim(host, app("mail", "Mail"));
    expect(host.calls.at(-1)).toEqual([
      "gsettings",
      "set",
      "org.gnome.shell",
      "favorite-apps",
      "['firefox.desktop', 'equin-mail.desktop']",
    ]);
  });
});

describe("stable helper and reconcile", () => {
  test("copies once per identity", () => {
    const state = join(root, "state");
    const src = helperBinary("v1");
    expect(syncStableHelper(state, src, "id-1").changed).toBe(true);
    expect(syncStableHelper(state, src, "id-1").changed).toBe(false);
    writeFileSync(src, "v2");
    const next = syncStableHelper(state, src, "id-2");
    expect(next.changed).toBe(true);
    expect(readFileSync(next.binary, "utf-8")).toBe("v2");
  });

  const binOf = (name: string) =>
    readFileSync(
      join(
        root,
        "home",
        "Applications",
        `equin ${name}.app`,
        "Contents",
        "MacOS",
        "equin-desktop",
      ),
      "utf-8",
    );
  const bundleOf = (name: string) =>
    join(root, "home", "Applications", `equin ${name}.app`);
  const sync = (
    host: ShimHost,
    helper: string,
    apps: ShimApp[],
    rewriteAll = false,
  ) => syncShims(host, helper, apps, { rewriteAll });

  test("writes a shim for every app, then nothing while they are current", async () => {
    const host = fakeHost("macos");
    const helper = helperBinary();
    const apps = [app("mail", "Mail"), app("pages", "Pages")];
    expect(await sync(host, helper, apps)).toEqual({
      written: ["mail", "pages"],
      removed: [],
    });
    expect(readInstalledAppIds(host)).toEqual(["mail", "pages"]);
    host.calls.length = 0;
    expect(await sync(host, helper, apps)).toEqual({
      written: [],
      removed: [],
    });
    expect(host.calls).toEqual([]);
  });

  test("rewrites a stale shim: a changed icon, or a new helper", async () => {
    const host = fakeHost("macos");
    const v1 = helperBinary("v1");
    await sync(host, v1, [app("mail", "Mail"), app("pages", "Pages")]);
    const changed = { ...app("mail", "Mail"), iconSvg: "<svg>new</svg>" };
    expect(await sync(host, v1, [changed, app("pages", "Pages")])).toEqual({
      written: ["mail"],
      removed: [],
    });
    const v2 = join(root, "helper-v2");
    writeFileSync(v2, "v2");
    expect(
      await sync(host, v2, [changed, app("pages", "Pages")], true),
    ).toEqual({ written: ["mail", "pages"], removed: [] });
    expect(binOf("Mail")).toBe("v2");
    expect(binOf("Pages")).toBe("v2");
  });

  test("a shim from before the fingerprint is rewritten once", async () => {
    const host = fakeHost("macos");
    const helper = helperBinary();
    await writeShim(host, app("mail", "Mail"), helper);
    const plist = join(bundleOf("Mail"), "Contents", "Info.plist");
    writeFileSync(
      plist,
      readFileSync(plist, "utf-8").replace(
        /\s*<key>EquinShimHash<\/key><string>[^<]*<\/string>/,
        "",
      ),
    );
    expect(await sync(host, helper, [app("mail", "Mail")])).toEqual({
      written: ["mail"],
      removed: [],
    });
  });

  test("removes a renamed app's old bundle and a gone app's shim", async () => {
    const host = fakeHost("macos");
    const helper = helperBinary();
    await sync(host, helper, [app("mail", "Mail"), app("gone", "Gone")]);
    // A bundle that is not an equin shim is never touched.
    mkdirSync(join(root, "home", "Applications", "Safari.app"));
    const result = await sync(host, helper, [app("mail", "Post")]);
    expect(result.written).toEqual(["mail"]);
    expect(result.removed.sort()).toEqual(["gone", "mail"]);
    expect(existsSync(bundleOf("Post"))).toBe(true);
    expect(existsSync(bundleOf("Mail"))).toBe(false);
    expect(existsSync(bundleOf("Gone"))).toBe(false);
    expect(existsSync(join(root, "home", "Applications", "Safari.app"))).toBe(
      true,
    );
    expect(readInstalledAppIds(host)).toEqual(["mail"]);
  });

  test("Linux: a gone app's desktop entry and icon are removed", async () => {
    const host = fakeHost("linux");
    await sync(host, "/stable/equin-desktop", [app("gone", "Gone")]);
    await sync(host, "/stable/equin-desktop", []);
    const share = join(root, "home", ".local", "share");
    expect(existsSync(join(share, "applications", "equin-gone.desktop"))).toBe(
      false,
    );
    expect(
      existsSync(
        join(share, "icons", "hicolor", "512x512", "apps", "equin-gone.png"),
      ),
    ).toBe(false);
  });

  test("reads which shims the Dock keeps", async () => {
    const host = fakeHost("macos");
    await sync(host, helperBinary(), [
      app("mail", "Mail"),
      app("pages", "Pages"),
    ]);
    const pinned = fakeHost("macos", {
      "defaults read com.apple.dock persistent-apps": `( { "_CFURLString" = "${dockFileUrl(bundleOf("Mail"))}"; } )`,
    });
    expect(await readPinnedAppIds(pinned)).toEqual(["mail"]);
  });
});
