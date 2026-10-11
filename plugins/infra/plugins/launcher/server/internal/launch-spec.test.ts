import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readyForTests } from "@plugins/infra/plugins/deps/deps/testing";
import { builtFile } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { gatewayBinary } from "../../deps";
import { gatewayLaunchSpec } from "./boot";
import { renderLaunchAgentPlist } from "./launchd-plist";

describe("gatewayLaunchSpec", () => {
  // The installed gateway as the deps cache names it: a path per identity.
  const dir =
    "/h/me/.singularity/cache/deps/gateway-binary/0123456789abcdef/env";
  const ready = readyForTests(gatewayBinary, dir, "0123456789abcdef");
  const checkout = "/h/me/src/singularity";
  const spec = gatewayLaunchSpec({
    gateway: ready,
    cwd: checkout,
    port: 9000,
    logLevel: "info",
  });

  test("runs the installed binary, from the checkout its children resolve their toolchain in", () => {
    expect(builtFile(ready)).toBe(join(dir, "gateway"));
    expect(spec.argv[0]).toBe(join(dir, "gateway"));
    expect(spec.cwd).toBe(checkout);
    expect(spec.argv).toContain("-child-env");
  });

  test("the launchd job names that binary, so a new identity is a new plist", () => {
    const xml = renderLaunchAgentPlist({
      label: "dev.singularity.gateway",
      argv: spec.argv,
      cwd: spec.cwd,
      env: {},
      stdioLog: spec.stdioLog,
    });
    expect(xml).toContain(
      `<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${join(dir, "gateway")}</string>`,
    );
    expect(xml).toContain(
      `<key>WorkingDirectory</key>\n\t<string>${checkout}</string>`,
    );
  });
});
