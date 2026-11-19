import { describe, expect, test } from "bun:test";
import { appScopeOf, scopeUnitName } from "./scope-name";

const cgroup = (leaf: string): string =>
  `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${leaf}\n`;

describe("scopeUnitName", () => {
  test("names the kind and the work, in characters systemd accepts", () => {
    expect(scopeUnitName("op", "build-1795052000-abcdef")).toBe(
      "equin-op-build-1795052000-abcdef.scope",
    );
    expect(scopeUnitName("daemon", "runtime-sdk.agent conv:1/x")).toBe(
      "equin-daemon-runtime-sdk.agent-conv-1-x.scope",
    );
  });
  test("refuses a label with nothing a unit name can carry", () => {
    expect(() => scopeUnitName("op", "///")).toThrow("nothing a unit name");
  });
});

describe("appScopeOf", () => {
  test("reads the app's own scope off the leaf, and its kind", () => {
    const unit = scopeUnitName("op", "check-42-x");
    expect(appScopeOf(cgroup(unit))).toEqual({ kind: "op", unit });
    const agent = scopeUnitName("daemon", "agent-1");
    expect(appScopeOf(cgroup(agent))).toEqual({ kind: "daemon", unit: agent });
  });
  test("the gateway's service, a terminal's scope and no cgroup v2 line are none of ours", () => {
    expect(appScopeOf(cgroup("dev.equin.gateway.service"))).toBeNull();
    expect(appScopeOf(cgroup("vte-spawn-1234.scope"))).toBeNull();
    expect(appScopeOf("")).toBeNull();
  });
});
