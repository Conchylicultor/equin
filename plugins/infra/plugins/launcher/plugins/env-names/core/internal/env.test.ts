import { describe, expect, test } from "bun:test";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import {
  EnvNameConflictError,
  envEntries,
  readEnv,
  setEnv,
  setEnvDefault,
  unsetEnv,
} from "./env";
import { envName, envNames } from "./env-keys";

const current = envName("DIR");
const legacy = `${LEGACY_IDS.envPrefix}DIR`;

describe("envNames", () => {
  test("current first, then the legacy name", () => {
    expect(envNames("DIR")).toEqual([current, legacy]);
  });

  test("a key born after the rename has only its current name", () => {
    expect(envNames("APP_COMPONENT")).toEqual([envName("APP_COMPONENT")]);
  });
});

describe("readEnv", () => {
  test("unset under both names", () => {
    expect(readEnv("DIR", {})).toBeUndefined();
  });

  test("the current name", () => {
    expect(readEnv("DIR", { [current]: "/new" })).toBe("/new");
  });

  test("falls back to the legacy name — an older writer set only it", () => {
    expect(readEnv("DIR", { [legacy]: "/old" })).toBe("/old");
  });

  test("both set and equal", () => {
    expect(readEnv("DIR", { [current]: "/d", [legacy]: "/d" })).toBe("/d");
  });

  test("both set and different throws, naming both", () => {
    expect(() =>
      readEnv("DIR", { [current]: "/new", [legacy]: "/old" }),
    ).toThrow(EnvNameConflictError);
    expect(() =>
      readEnv("DIR", { [current]: "/new", [legacy]: "/old" }),
    ).toThrow(new RegExp(`${current}.*${legacy}`));
  });

  test("a prefixed key reads both names too", () => {
    expect(
      readEnv("AUTH_GOOGLE_CLIENT_ID", {
        [`${LEGACY_IDS.envPrefix}AUTH_GOOGLE_CLIENT_ID`]: "id",
      }),
    ).toBe("id");
  });
});

describe("writers", () => {
  test("envEntries sets every name, undefined included", () => {
    expect(envEntries({ DIR: "/d" })).toEqual({
      [current]: "/d",
      [legacy]: "/d",
    });
    expect(envEntries({ DIR: undefined })).toEqual({
      [current]: undefined,
      [legacy]: undefined,
    });
  });

  test("setEnv / unsetEnv write and remove both names", () => {
    const env: Record<string, string | undefined> = {};
    setEnv("DIR", "/d", env);
    expect(env).toEqual({ [current]: "/d", [legacy]: "/d" });
    unsetEnv("DIR", env);
    expect(env).toEqual({});
  });

  test("setEnvDefault keeps an existing value and copies it to both names", () => {
    const env: Record<string, string | undefined> = { [legacy]: "/old" };
    expect(setEnvDefault("DIR", "/default", env)).toBe("/old");
    expect(env).toEqual({ [current]: "/old", [legacy]: "/old" });
    const empty: Record<string, string | undefined> = {};
    expect(setEnvDefault("DIR", "/default", empty)).toBe("/default");
    expect(empty).toEqual({ [current]: "/default", [legacy]: "/default" });
  });
});
