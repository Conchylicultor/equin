import { describe, expect, test } from "bun:test";
import {
  dockFileUrl,
  dockPinPlan,
  gnomePinPlan,
  linuxShimPaths,
  macShimPaths,
  parseGsettingsStrv,
  readDesktopFileAppId,
  readShimPlistAppId,
  renderDesktopFile,
  renderGsettingsStrv,
  renderShimInfoPlist,
  type ShimApp,
} from "./shim-files";
import { installCapabilities } from "./capabilities";

const MAIL: ShimApp = {
  id: "mail",
  name: "Mail",
  url: "http://equin.localhost:9000/mail",
  namespace: "singularity",
};
const ROOTS = {
  macApplications: "/tmp/home/Applications",
  xdgDataHome: "/tmp/home/.local/share",
};

describe("macOS shim", () => {
  test("lives at ~/Applications/equin <Name>.app", () => {
    const p = macShimPaths(ROOTS, MAIL);
    expect(p.bundle).toBe("/tmp/home/Applications/equin Mail.app");
    expect(p.executable).toBe(
      "/tmp/home/Applications/equin Mail.app/Contents/MacOS/equin-desktop",
    );
    expect(p.icns).toBe(
      "/tmp/home/Applications/equin Mail.app/Contents/Resources/app.icns",
    );
  });

  test("Info.plist carries the contract keys and no LSUIElement", () => {
    const plist = renderShimInfoPlist(MAIL);
    const value = (key: string) =>
      new RegExp(`<key>${key}</key><string>([^<]*)</string>`).exec(plist)?.[1];
    expect(value("CFBundleIdentifier")).toBe("dev.equin.app.mail");
    expect(value("CFBundleExecutable")).toBe("equin-desktop");
    expect(value("CFBundleName")).toBe("Mail");
    expect(value("CFBundleIconFile")).toBe("app");
    expect(value("CFBundlePackageType")).toBe("APPL");
    expect(value("EquinAppId")).toBe("mail");
    expect(value("EquinUrl")).toBe("http://equin.localhost:9000/mail");
    expect(value("EquinNamespace")).toBe("singularity");
    expect(plist).not.toContain("LSUIElement");
    // Without the ATS exception the bundle's WKWebView never loads
    // http://*.localhost:9000.
    expect(plist).toContain(
      "<key>NSAppTransportSecurity</key><dict><key>NSExceptionDomains</key><dict><key>localhost</key><dict><key>NSIncludesSubdomains</key><true/><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict></dict></dict>",
    );
    expect(readShimPlistAppId(plist)).toBe("mail");
  });

  test("escapes a name with XML metacharacters", () => {
    const plist = renderShimInfoPlist({ ...MAIL, name: "Tom & <Jerry>" });
    expect(plist).toContain("<string>Tom &amp; &lt;Jerry&gt;</string>");
  });
});

describe("Linux shim", () => {
  test("desktop entry and icon paths", () => {
    const p = linuxShimPaths(ROOTS, "mail");
    expect(p.desktopFile).toBe(
      "/tmp/home/.local/share/applications/equin-mail.desktop",
    );
    expect(p.icon).toBe(
      "/tmp/home/.local/share/icons/hicolor/512x512/apps/equin-mail.png",
    );
  });

  test("runs the stable helper in window mode, grouped by its WM class", () => {
    const text = renderDesktopFile(MAIL, "/data/state/menu-bar/equin-desktop");
    expect(text).toContain(
      "Exec=/data/state/menu-bar/equin-desktop window --app mail --url http://equin.localhost:9000/mail\n",
    );
    expect(text).toContain("StartupWMClass=equin-mail\n");
    expect(text).toContain("Icon=equin-mail\n");
    expect(text).toContain("Name=Mail\n");
    expect(text.startsWith("[Desktop Entry]\nType=Application\n")).toBe(true);
    expect(readDesktopFileAppId(text)).toBe("mail");
  });

  test("quotes an Exec argument with spaces", () => {
    const text = renderDesktopFile(MAIL, "/home/a b/equin-desktop");
    expect(text).toContain('Exec="/home/a b/equin-desktop" window');
  });
});

describe("Dock pin", () => {
  const bundle = "/tmp/home/Applications/equin Mail.app";
  test("appends one persistent-apps tile, then restarts the Dock", () => {
    const plan = dockPinPlan("(\n)", bundle);
    expect(plan).toHaveLength(2);
    const [write, restart] = plan;
    expect(write!.slice(0, 5)).toEqual([
      "defaults",
      "write",
      "com.apple.dock",
      "persistent-apps",
      "-array-add",
    ]);
    expect(write![5]).toContain(
      "<string>file:///tmp/home/Applications/equin%20Mail.app/</string>",
    );
    expect(write![5]).toContain(
      "<key>_CFURLStringType</key><integer>15</integer>",
    );
    expect(restart).toEqual(["killall", "Dock"]);
  });

  test("does nothing when the bundle is already pinned", () => {
    const current = `(\n {\n "tile-data" = { "file-data" = { "_CFURLString" = "${dockFileUrl(bundle)}"; }; };\n }\n)`;
    expect(dockPinPlan(current, bundle)).toEqual([]);
  });
});

describe("GNOME dash pin", () => {
  test("parses gsettings string arrays", () => {
    expect(parseGsettingsStrv("@as []\n")).toEqual([]);
    expect(
      parseGsettingsStrv("['org.gnome.Nautilus.desktop', 'firefox.desktop']\n"),
    ).toEqual(["org.gnome.Nautilus.desktop", "firefox.desktop"]);
    expect(() => parseGsettingsStrv("No such schema")).toThrow();
  });

  test("appends the shim's desktop id to the favorites", () => {
    expect(gnomePinPlan("['firefox.desktop']", "mail")).toEqual([
      [
        "gsettings",
        "set",
        "org.gnome.shell",
        "favorite-apps",
        "['firefox.desktop', 'equin-mail.desktop']",
      ],
    ]);
    expect(gnomePinPlan("['equin-mail.desktop']", "mail")).toEqual([]);
  });

  test("round-trips quotes", () => {
    const items = ["it's.desktop", "plain.desktop"];
    expect(parseGsettingsStrv(renderGsettingsStrv(items))).toEqual(items);
  });
});

describe("capabilities", () => {
  test("macOS installs and pins; Linux pins only on GNOME; others neither", () => {
    expect(
      installCapabilities({ platform: "darwin", gnomeFavorites: false }),
    ).toMatchObject({ platform: "macos", install: true, pin: true });
    expect(
      installCapabilities({ platform: "linux", gnomeFavorites: true }),
    ).toMatchObject({ platform: "linux", install: true, pin: true });
    const kde = installCapabilities({
      platform: "linux",
      gnomeFavorites: false,
    });
    expect(kde).toMatchObject({ install: true, pin: false });
    expect(kde.reason).toContain("GNOME");
    expect(
      installCapabilities({ platform: "win32", gnomeFavorites: false }),
    ).toMatchObject({ platform: "other", install: false, pin: false });
  });
});
