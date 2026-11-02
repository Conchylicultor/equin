import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { LEGEND_MARKER } from "@plugins/config_v2/core/testing";
import { applyOverrideLegends } from "./override-legend-stamp";

let configDir: AppPath;

beforeEach(() => {
  configDir = asAppPath(mkdtempSync(join(tmpdir(), "override-legend-")));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = join(configDir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(rel: string): string {
  return readFileSync(join(configDir, rel), "utf8");
}

/** The stamp reads only `name` + `overrideLegend`. */
function descriptor(overrideLegend?: readonly string[]): ConfigDescriptor {
  return { name: "header", overrideLegend } as unknown as ConfigDescriptor;
}

test("stamps the base override and every @app fork, and never creates a file", async () => {
  write("a/b/header.jsonc", '// @hash abc\n{ "items": [] }\n');
  write("a/b/@app/mail/header.jsonc", '// @hash abc\n{ "items": [] }\n');
  mkdirSync(join(configDir, "a/b/@app/pages"), { recursive: true });

  const stamped = await applyOverrideLegends({
    configDir,
    descriptorsByOriginRel: new Map([
      ["a/b/header.origin.jsonc", descriptor(["Spacer: …"])],
    ]),
  });

  expect(stamped.sort()).toEqual([
    "a/b/@app/mail/header.jsonc",
    "a/b/header.jsonc",
  ]);
  for (const rel of stamped) {
    expect(read(rel)).toContain(`${LEGEND_MARKER}`);
    expect(read(rel)).toContain("//   Spacer: …");
  }
  expect(existsSync(join(configDir, "a/b/@app/pages/header.jsonc"))).toBe(
    false,
  );
});

test("a second pass changes nothing", async () => {
  write("a/header.jsonc", "// @hash abc\n{}\n");
  const opts = {
    configDir,
    descriptorsByOriginRel: new Map([
      ["a/header.origin.jsonc", descriptor(["X"])],
    ]),
  };
  await applyOverrideLegends(opts);
  expect(await applyOverrideLegends(opts)).toEqual([]);
});

test("skips descriptors without a legend and hashless files", async () => {
  write("a/header.jsonc", "// @hash abc\n{}\n");
  write("b/header.jsonc", "{}\n");
  const stamped = await applyOverrideLegends({
    configDir,
    descriptorsByOriginRel: new Map([
      ["a/header.origin.jsonc", descriptor()],
      ["b/header.origin.jsonc", descriptor(["X"])],
    ]),
  });
  expect(stamped).toEqual([]);
  expect(read("b/header.jsonc")).toBe("{}\n");
});
