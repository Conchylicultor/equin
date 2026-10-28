import { describe, expect, test } from "bun:test";
import { envEntries, readEnv, setEnv, setEnvDefault, unsetEnv } from "./env";
import { ENV_PREFIX, envKeyOf, envName, isDeclaredEnvName } from "./env-keys";

const name = envName("DIR");

describe("names", () => {
  test("a key's one name is the product prefix + key", () => {
    expect(name).toBe(`${ENV_PREFIX}DIR`);
    expect(envKeyOf(name)).toBe("DIR");
    expect(envKeyOf("HOME")).toBeUndefined();
  });

  test("declared keys and prefixes", () => {
    expect(isDeclaredEnvName(name)).toBe(true);
    expect(isDeclaredEnvName(envName("AUTH_GOOGLE_CLIENT_ID"))).toBe(true);
    expect(isDeclaredEnvName(`${name}_NOT_A_KEY`)).toBe(false);
  });
});

describe("readEnv", () => {
  test("unset", () => {
    expect(readEnv("DIR", {})).toBeUndefined();
  });

  test("set", () => {
    expect(readEnv("DIR", { [name]: "/d" })).toBe("/d");
  });
});

describe("writers", () => {
  test("envEntries keys each value by its name, undefined included", () => {
    expect(envEntries({ DIR: "/d" })).toEqual({ [name]: "/d" });
    expect(envEntries({ DIR: undefined })).toEqual({ [name]: undefined });
  });

  test("setEnv / unsetEnv write and remove the name", () => {
    const env: Record<string, string | undefined> = {};
    setEnv("DIR", "/d", env);
    expect(env).toEqual({ [name]: "/d" });
    unsetEnv("DIR", env);
    expect(env).toEqual({});
  });

  test("setEnvDefault keeps an existing value", () => {
    const env: Record<string, string | undefined> = { [name]: "/set" };
    expect(setEnvDefault("DIR", "/default", env)).toBe("/set");
    expect(env).toEqual({ [name]: "/set" });
    const empty: Record<string, string | undefined> = {};
    expect(setEnvDefault("DIR", "/default", empty)).toBe("/default");
    expect(empty).toEqual({ [name]: "/default" });
  });
});
