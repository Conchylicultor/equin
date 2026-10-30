import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostInputsHash,
  hostInputsHasher,
  matchHostRecord,
  type HostInputs,
  type HostInputsRecord,
} from "./browser-hosts";

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

describe("matchHostRecord", () => {
  // Two checkouts of the same repo whose host graphs differ in one file.
  let a: string;
  let b: string;
  const write = (root: string, rel: string, body: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  beforeEach(() => {
    a = mkdtempSync(join(tmpdir(), "browser-host-a-"));
    b = mkdtempSync(join(tmpdir(), "browser-host-b-"));
    for (const root of [a, b]) {
      write(root, "bun.lock", "lock");
      write(root, "src/host.ts", "host");
    }
    write(a, "src/server.ts", "server v1");
    write(b, "src/server.ts", "server v2");
    write(b, "src/extra.ts", "only b loads this");
  });
  afterEach(() => {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  const record = (root: string, inputs: HostInputs): HostInputsRecord => ({
    ...inputs,
    inputsHash: hostInputsHash(root, inputs, "id")!,
  });
  const builtInA = (): HostInputsRecord =>
    record(a, { files: ["src/host.ts", "src/server.ts"], globRoots: [] });
  const builtInB = (): HostInputsRecord =>
    record(b, {
      files: ["src/extra.ts", "src/host.ts", "src/server.ts"],
      globRoots: [],
    });

  test("each checkout finds its own build, whichever was recorded last", () => {
    const ra = builtInA();
    const rb = builtInB();
    for (const order of [
      [ra, rb],
      [rb, ra],
    ]) {
      expect(matchHostRecord(order, hostInputsHasher(a, "id"))).toBe(ra);
      expect(matchHostRecord(order, hostInputsHasher(b, "id"))).toBe(rb);
    }
  });

  test("a checkout no stored build describes matches none (it builds)", () => {
    const rb = builtInB();
    expect(matchHostRecord([rb], hostInputsHasher(a, "id"))).toBeNull();
  });

  test("an edit to a loaded file unmatches the record", () => {
    const ra = builtInA();
    write(a, "src/server.ts", "server v1, edited");
    expect(matchHostRecord([ra], hostInputsHasher(a, "id"))).toBeNull();
  });

  test("another builder identity matches nothing", () => {
    const ra = builtInA();
    expect(matchHostRecord([ra], hostInputsHasher(a, "other"))).toBeNull();
  });
});
