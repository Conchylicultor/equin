import { describe, expect, test } from "bun:test";
import { INSTALL_VERB } from "../core";
import { isInstallInvocation } from "./install-verb";

describe("isInstallInvocation", () => {
  test("a bare install is the bootstrap's", () => {
    expect(isInstallInvocation([INSTALL_VERB])).toBe(true);
  });

  test("anything else goes to the CLI", () => {
    expect(isInstallInvocation([])).toBe(false);
    expect(isInstallInvocation([INSTALL_VERB, "--help"])).toBe(false);
    expect(isInstallInvocation(["build"])).toBe(false);
    expect(isInstallInvocation(["run", INSTALL_VERB])).toBe(false);
  });
});
