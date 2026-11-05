/**
 * Reading a backend's composition off its own `spec.json`.
 *
 * The arms that matter are the four "no composition" ones — each a real spawn
 * shape, and all of them the main app — set against the one that must NOT
 * degrade to that: a spec that exists but is corrupt. Guessing there would boot
 * the wrong app under a composition's own namespace and database.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WORKTREE_SPEC_FILE } from "@plugins/infra/plugins/paths/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import {
  assertServesComposition,
  readSpecComposition,
} from "./spec-composition";

const worktreesDir = mkdtempSync(join(tmpdir(), "spec-composition-test-"));
afterAll(() => rmSync(worktreesDir, { recursive: true, force: true }));

/** Register a namespace with the given raw spec.json body. */
const writeSpec = (namespace: string, body: string) => {
  mkdirSync(join(worktreesDir, namespace), { recursive: true });
  writeFileSync(join(worktreesDir, namespace, WORKTREE_SPEC_FILE), body);
};

writeSpec(
  "sonata.att-1785964183-wqzj",
  JSON.stringify({ server: "/repo", web: "/dist", composition: "sonata" }),
);
// The shape every spec had before the field existed — and `central`'s today.
writeSpec("central", JSON.stringify({ server: "/repo" }));
writeSpec("torn", '{ "server": "/repo", "compos');
writeSpec("array", "[]");
writeSpec("wrong-type", JSON.stringify({ server: "/repo", composition: 7 }));
writeSpec("blank", JSON.stringify({ server: "/repo", composition: "" }));

test("a spec that declares a composition answers with it", () => {
  expect(readSpecComposition(worktreesDir, "sonata.att-1785964183-wqzj")).toBe(
    "sonata",
  );
});

test("the four ways to mean the main app", () => {
  // 1. No namespace — a hand-run backend.
  expect(readSpecComposition(worktreesDir, undefined)).toBeUndefined();
  expect(readSpecComposition(worktreesDir, "")).toBeUndefined();
  // 2. No spec file — not gateway-spawned, or not registered yet.
  expect(readSpecComposition(worktreesDir, "never-written")).toBeUndefined();
  // 3. A spec with no `composition` key — pre-composition specs, and central.
  expect(readSpecComposition(worktreesDir, "central")).toBeUndefined();
  // 4. An empty composition, handed through for selectRegistry to read as main.
  expect(readSpecComposition(worktreesDir, "blank")).toBe("");
});

test("a spec that exists but is corrupt throws instead of meaning the main app", () => {
  expect(() => readSpecComposition(worktreesDir, "torn")).toThrow(
    "Malformed spec at",
  );
  expect(() => readSpecComposition(worktreesDir, "array")).toThrow(
    "expected a JSON object",
  );
  expect(() => readSpecComposition(worktreesDir, "wrong-type")).toThrow(
    '"composition" must be a string',
  );
});

test("a backend serves only the composition its spec declares", () => {
  // No composition declared is the main app: only the main entry may serve it.
  assertServesComposition(undefined, [
    MAIN_COMPOSITION_ID,
    MAIN_COMPOSITION_ID,
  ]);
  assertServesComposition("", [MAIN_COMPOSITION_ID]);
  assertServesComposition("sonata", ["sonata", "sonata"]);
  // The main entry under a composition's namespace — a spec written before the
  // composition's entry existed — must not boot the full app there.
  expect(() =>
    assertServesComposition("sonata", [MAIN_COMPOSITION_ID]),
  ).toThrow(
    /declares "sonata", whose entry is bin\/index\.composition\.sonata\.generated\.ts/,
  );
  expect(() => assertServesComposition(undefined, ["sonata"])).toThrow(
    /boots the "sonata" composition/,
  );
  // Both halves must be the same app.
  expect(() =>
    assertServesComposition("sonata", ["sonata", MAIN_COMPOSITION_ID]),
  ).toThrow();
});
