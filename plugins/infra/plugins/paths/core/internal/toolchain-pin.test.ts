import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths";
import { toolchainPin } from "./toolchain-pin";

const saved = readEnv("RELEASE");
afterEach(() => {
  if (saved === undefined) unsetEnv("RELEASE");
  else setEnv("RELEASE", saved);
});

describe("toolchainPin", () => {
  test("points mise's global config at this checkout's mise.toml", () => {
    unsetEnv("RELEASE");
    const pin = toolchainPin();
    expect(pin).toEqual({
      MISE_GLOBAL_CONFIG_FILE: join(REPO_ROOT, "mise.toml"),
    });
    expect(existsSync(pin.MISE_GLOBAL_CONFIG_FILE!)).toBe(true);
  });

  test("pins nothing in a release, which has no checkout", () => {
    setEnv("RELEASE", "1");
    expect(toolchainPin()).toEqual({});
  });
});
