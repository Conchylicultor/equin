/**
 * The backend's registry selection: by COMPOSITION IDENTITY, never by which
 * files happen to be on disk.
 *
 * Every arm is asserted, including the two that used to be one silent fallback:
 * a stray `server.composition.singularity.generated.ts` must be inert (it would
 * otherwise reconfigure main's backend on its next spawn), and a missing
 * filtered registry must THROW (it would otherwise boot the full app under a
 * composition's own namespace and database, looking like it worked).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { selectRegistry } from "./select-registry";

const coreDir = mkdtempSync(join(tmpdir(), "select-registry-test-"));
afterAll(() => rmSync(coreDir, { recursive: true, force: true }));

const write = (file: string) =>
  writeFileSync(join(coreDir, file), "export {};\n");
const full = join(coreDir, "server.generated.ts");
const website = join(coreDir, "server.composition.website.generated.ts");

write("server.generated.ts");
write("server.composition.website.generated.ts");
write("server.composition.generated.ts"); // legacy singleton — must be ignored
// The file that used to hijack main's backend by merely existing.
write("server.composition.singularity.generated.ts");

test("a composition selects ITS filtered registry", () => {
  expect(selectRegistry(coreDir, "website", "website", "server")).toBe(website);
  // The namespace is not what selects: the same composition served from a
  // worktree carries a two-label namespace and picks the same registry.
  expect(
    selectRegistry(coreDir, "website.att-1785964183-wqzj", "website", "server"),
  ).toBe(website);
});

test("the main composition selects the committed registry, stray file or not", () => {
  expect(selectRegistry(coreDir, "singularity", "singularity", "server")).toBe(
    full,
  );
});

test("no composition in the env is the main app", () => {
  expect(
    selectRegistry(coreDir, "att-1785964183-wqzj", undefined, "server"),
  ).toBe(full);
  expect(selectRegistry(coreDir, "att-1785964183-wqzj", "", "server")).toBe(
    full,
  );
  expect(selectRegistry(coreDir, undefined, undefined, "server")).toBe(full);
  // Another composition's filtered file is on disk (and so is a legacy
  // singleton); neither may be selected when no composition was declared.
  expect(selectRegistry(coreDir, "website", undefined, "server")).toBe(full);
});

test("a composition whose registry is missing throws instead of booting the full app", () => {
  expect(() => selectRegistry(coreDir, "sonata", "sonata", "server")).toThrow(
    "has no server registry at",
  );
});

test("a namespace-unsafe runtime namespace throws instead of falling back", () => {
  for (const bad of [
    "Website",
    "we bsite",
    "../evil",
    "-website",
    // 64 bytes — one over the datname cap, so its database would be a
    // different (truncated) name than the one it is serving under.
    `${"a".repeat(32)}.${"b".repeat(31)}`,
  ]) {
    expect(() => selectRegistry(coreDir, bad, undefined, "server")).toThrow(
      "cannot select a plugin registry",
    );
  }
});

test("a label-unsafe composition throws before it becomes a filename", () => {
  for (const bad of ["../evil", "Website", "a.b", "-website", "a/b"]) {
    expect(() => selectRegistry(coreDir, "website", bad, "server")).toThrow(
      "cannot select a plugin registry",
    );
  }
});

test("the machine registry is selected by the same identity, beside the server one", () => {
  write("machine.generated.ts");
  write("machine.composition.website.generated.ts");
  expect(selectRegistry(coreDir, "website", "website", "machine")).toBe(
    join(coreDir, "machine.composition.website.generated.ts"),
  );
  expect(selectRegistry(coreDir, "singularity", undefined, "machine")).toBe(
    join(coreDir, "machine.generated.ts"),
  );
  expect(() => selectRegistry(coreDir, "sonata", "sonata", "machine")).toThrow(
    "has no machine registry at",
  );
});
