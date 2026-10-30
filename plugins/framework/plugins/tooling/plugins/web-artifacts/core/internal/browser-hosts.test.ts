import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostInputsHash } from "./browser-hosts";

describe("hostInputsHash", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "browser-host-inputs-"));
    writeFileSync(join(root, "bun.lock"), "lock");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/host.ts"), "host");
    mkdirSync(join(root, "config/a"), { recursive: true });
    writeFileSync(join(root, "config/a/x.origin.jsonc"), "{}");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const inputs = { files: ["src/host.ts"], globRoots: ["config"] };

  test("a new file in a new subdirectory of a glob root re-addresses the host", () => {
    const before = hostInputsHash(root, inputs, "id");
    mkdirSync(join(root, "config/new"));
    writeFileSync(join(root, "config/new/y.origin.jsonc"), "{}");
    expect(hostInputsHash(root, inputs, "id")).not.toBe(before);
  });

  test("without the glob root the same tree hashes the same", () => {
    const flat = { files: inputs.files, globRoots: [] };
    const before = hostInputsHash(root, flat, "id");
    mkdirSync(join(root, "config/new"));
    expect(hostInputsHash(root, flat, "id")).toBe(before);
  });

  test("a recorded file that is gone is no address", () => {
    rmSync(join(root, "src/host.ts"));
    expect(hostInputsHash(root, inputs, "id")).toBeNull();
  });
});
