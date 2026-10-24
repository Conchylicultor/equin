import { describe, expect, test } from "bun:test";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { readyForTests } from "@plugins/infra/plugins/deps/deps/testing";
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
  spec: (ready) => ({
    argv: [`${ready.dir}/bin`, "tray"],
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
    expect(loginServiceJob(decl, ready)).toEqual({
      description: "An example tray helper",
      argv: ["/cache/x/env/bin", "tray"],
      cwd: "/cache/x/env",
      env: { HOME: "/h/me" },
      stdioLog: "/h/me/logs/example.log",
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
