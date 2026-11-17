import { describe, expect, test } from "bun:test";
import {
  defineNotice,
  plainTextProblems,
  renderNotice,
  type InstallerNotice,
} from "./notice";

const good: InstallerNotice = {
  title: "macOS blocked equin from adding its apps",
  doing:
    "equin was adding an icon in your menu bar and its apps in their own windows.",
  blocked: "This Mac only lets apps you approved change other apps.",
  now: [
    "Turn on the app you ran the installer from in System Settings → Privacy & Security → App Management, then run `./equin start` again.",
  ],
  ifSkipped: {
    optional: true,
    stillWorks:
      "equin works fully in your browser at http://equin.localhost:9000.",
    addLater: "Add them later with `./equin start --only dev.equin.menu-bar`.",
  },
  evidence: [
    "refused to write ~/Applications/equin.app: Operation not permitted",
  ],
};

describe("installer notice", () => {
  test("a notice keeping every rule is accepted", () => {
    expect(defineNotice(good)).toBe(good);
  });

  test("internal names, paths and labels are refused outside commands and URLs", () => {
    expect(plainTextProblems("Installing the menu-bar helper")).toContain(
      'internal name "menu-bar helper"',
    );
    expect(plainTextProblems("the gateway did not start")).toContain(
      'internal name "gateway"',
    );
    expect(plainTextProblems("could not write ~/Applications/x")).toEqual([
      'path "~/Applications/x"',
    ]);
    expect(plainTextProblems("skipped dev.equin.menu-bar")).toEqual([
      'label "dev.equin.menu-bar"',
    ]);
    expect(
      plainTextProblems("run `./equin start --only dev.equin.gateway`"),
    ).toEqual([]);
  });

  test("defineNotice names each broken rule", () => {
    expect(() =>
      defineNotice({ ...good, blocked: "launchd refused\nEPERM", now: [] }),
    ).toThrow(/blocked: internal name "launchd"[\s\S]*now: no step/);
  });

  test("the evidence is rendered apart, under Details", () => {
    const text = renderNotice(good);
    const [message, details] = text.split("Details (for a bug report):");
    expect(message).not.toContain("Operation not permitted");
    expect(details).toContain("Operation not permitted");
    expect(message).toContain("It's optional:");
  });
});
