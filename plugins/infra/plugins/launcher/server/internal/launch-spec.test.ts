import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readyForTests } from "@plugins/infra/plugins/deps/deps/testing";
import { builtFile } from "@plugins/infra/plugins/deps/plugins/build/deps";
import {
  executableEnv,
  unbundledExecutable,
} from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import { gatewayBinary, gatewayBuild } from "../../deps";
import { gatewayLaunchSpec } from "./boot";
import { gatewayServiceJob } from "./gateway-service";
import { LOOPBACK_BIND } from "./listen";

describe("gatewayLaunchSpec", () => {
  // The installed gateway as the deps cache names it: a path per identity.
  const dir =
    "/h/me/.singularity/cache/deps/gateway-binary/0123456789abcdef/env";
  const ready = readyForTests(gatewayBinary, dir, "0123456789abcdef");
  const checkout = "/h/me/src/singularity";
  const executable = unbundledExecutable(gatewayBuild(ready));
  const spec = gatewayLaunchSpec({
    executable,
    cwd: checkout,
    port: 9000,
    bindHost: LOOPBACK_BIND,
    logLevel: "info",
  });

  test("runs the installed binary, from the checkout its children resolve their toolchain in", () => {
    expect(builtFile(ready)).toBe(join(dir, "gateway"));
    expect(spec.argv[0]).toBe(join(dir, "gateway"));
    expect(spec.cwd).toBe(checkout);
    expect(spec.argv).toContain("-child-env");
  });

  test("listens on loopback unless a wildcard is asked for explicitly", () => {
    const at = spec.argv.indexOf("-listen");
    expect(spec.argv[at + 1]).toBe("loopback:9000");
    const wildcard = gatewayLaunchSpec({
      executable,
      cwd: checkout,
      port: 9000,
      bindHost: null,
      logLevel: "info",
    });
    expect(wildcard.argv[wildcard.argv.indexOf("-listen") + 1]).toBe(":9000");
  });

  test("the service job names that binary, so a new identity is a new job definition", () => {
    const job = gatewayServiceJob(spec);
    expect(job.argv).toEqual(spec.argv);
    expect(job.argv[0]).toBe(join(dir, "gateway"));
    expect(job.cwd).toBe(checkout);
    expect(job.stdioLog).toBe(spec.stdioLog);
    // An unbundled path already names its build: nothing added.
    expect(executableEnv(executable)).toEqual({});
  });

  test("a bundled gateway runs from the app, its build named in the job's environment", () => {
    const inApp = {
      path: "/h/me/.singularity/state/macos-app/equin.app/Contents/MacOS/gateway",
      identity: gatewayBuild(ready).identity,
      bundled: true,
    };
    const added = executableEnv(inApp);
    expect(Object.values(added)).toEqual(["gateway-binary@0123456789abcdef"]);
    const bundled = gatewayLaunchSpec({
      executable: inApp,
      cwd: checkout,
      port: 9000,
      bindHost: LOOPBACK_BIND,
      logLevel: "info",
    });
    expect(bundled.argv[0]).toBe(
      "/h/me/.singularity/state/macos-app/equin.app/Contents/MacOS/gateway",
    );
    expect(bundled.env).toMatchObject(added);
    // Not one of the names the gateway hands its children.
    const childEnv = bundled.argv[bundled.argv.indexOf("-child-env") + 1]!;
    for (const name of Object.keys(added))
      expect(childEnv.split(",")).not.toContain(name);
  });
});
