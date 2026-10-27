import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindInstalledLabel } from "./installed-label";

const dirs: string[] = [];
function definitions(installed: string[]): (label: string) => string {
  const dir = mkdtempSync(join(tmpdir(), "installed-label-"));
  dirs.push(dir);
  for (const label of installed) writeFileSync(join(dir, label), "");
  return (label) => join(dir, label);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

const ID = {
  label: "dev.new.svc",
  session: "background",
  installedAs: ["dev.old.svc"],
} as const;

test("nothing installed → its own label", () => {
  expect(bindInstalledLabel(ID, definitions([])).label).toBe("dev.new.svc");
});

test("the old label still installed → bound to it", () => {
  expect(bindInstalledLabel(ID, definitions(["dev.old.svc"]))).toEqual({
    label: "dev.old.svc",
    session: "background",
  });
});

test("only the new label installed → its own label", () => {
  expect(bindInstalledLabel(ID, definitions(["dev.new.svc"])).label).toBe(
    "dev.new.svc",
  );
});
