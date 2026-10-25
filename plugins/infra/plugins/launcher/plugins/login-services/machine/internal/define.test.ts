import { describe, expect, test } from "bun:test";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { readyForTests } from "@plugins/infra/plugins/deps/deps/testing";
import { componentIdentity, unbundledExecutable } from "../../core";
import { APP_COMPONENT_ENV } from "../../core/internal/app-component";
import {
  defineLoginService,
  isLoginServiceDeclaration,
  loginServiceHolder,
  loginServiceId,
  loginServiceJob,
} from "./define";

const helper = defineDep({
  id: "example-helper",
  owner: "example",
  description: "",
  sizeHint: "",
  source: {
    kind: "fake",
    label: "",
    identityInputs: async () => ({}),
    install: async () => {},
  },
  updates: { none: "a test fixture" },
});

const decl = defineLoginService({
  id: "dev.equin.example",
  owner: "example",
  description: "An example tray helper",
  session: "graphical",
  dep: helper,
  executable: {
    name: "example",
    build: (ready) => ({
      file: `${ready.dir}/bin`,
      identity: componentIdentity(helper.id, ready.identity),
    }),
  },
  spec: (ready, executable) => ({
    argv: [executable, "tray"],
    cwd: ready.dir,
    env: { HOME: "/h/me" },
    stdioLog: "/h/me/logs/example.log",
  }),
});

describe("defineLoginService", () => {
  test("its id is the service label, its session the declaration's", () => {
    expect(isLoginServiceDeclaration(decl)).toBe(true);
    expect(loginServiceId(decl)).toEqual({
      label: "dev.equin.example",
      session: "graphical",
    });
  });

  test("the job is the declaration's description plus what spec computes from the install", () => {
    const ready = readyForTests(helper, "/cache/x/env", "x");
    expect(
      loginServiceJob(
        decl,
        ready,
        unbundledExecutable(decl.executable.build(ready)),
      ),
    ).toEqual({
      description: "An example tray helper",
      argv: ["/cache/x/env/bin", "tray"],
      cwd: "/cache/x/env",
      env: { HOME: "/h/me" },
      stdioLog: "/h/me/logs/example.log",
    });
  });

  test("a bundled executable runs from its path, its build named in the environment", () => {
    const ready = readyForTests(helper, "/cache/x/env", "x");
    const job = loginServiceJob(decl, ready, {
      path: "/app/equin.app/Contents/MacOS/example",
      identity: "example-helper@x",
      bundled: true,
    });
    expect(job.argv).toEqual(["/app/equin.app/Contents/MacOS/example", "tray"]);
    expect(job.env).toEqual({
      HOME: "/h/me",
      [APP_COMPONENT_ENV]: "example-helper@x",
    });
  });

  test("the hold names the service in holdDep's holder grammar", () => {
    expect(loginServiceHolder(decl)).toBe("login-service-dev-equin-example");
    expect(loginServiceHolder(decl)).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test("refuses an id that is not a reverse-DNS label", () => {
    expect(() => defineLoginService({ ...decl, id: "Menu Bar" })).toThrow(
      /reverse-DNS/,
    );
    expect(() => defineLoginService({ ...decl, id: "menubar" })).toThrow(
      /reverse-DNS/,
    );
  });
});
