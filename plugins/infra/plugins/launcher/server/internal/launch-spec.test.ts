import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readyForTests } from "@plugins/infra/plugins/deps/deps/testing";
import { builtFile } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { gatewayBinary } from "../../deps";
import { gatewayLaunchSpec } from "./boot";
import { gatewayServiceJob } from "./gateway-service";
import { LOOPBACK_BIND } from "./listen";

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
      gateway: ready,
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
  });
});
