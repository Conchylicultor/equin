// The two rule kinds, end to end through `buildLintConfig`: the classifier,
// what a `kind` selection registers, and the `{ none: true }` type source —
// under which a type-aware rule must THROW, never silently pass, since a pass
// there would be cached as a syntactic result keyed on the file's text alone.

import { describe, expect, it } from "bun:test";
import { join } from "path";
import { Linter } from "eslint";
import {
  buildLintConfig,
  isTypeAwareRule,
  typeAwareLintGroups,
  type LintRuleSelection,
} from "./build-lint-config";

// This file's location, seven folders down from the repo root.
const ROOT = join(import.meta.dir, "../../../../../../..");
const BUTTON_SAFETY =
  "framework/plugins/tooling/plugins/lint/plugins/button-safety";
// A web file of a real plugin (a fake plugin path fails plugin-refs-resolve),
// in scope for every contributed rule (not a test / e2e file). It need not exist.
const PROBE = join(ROOT, "plugins/apps/plugins/home/web/rule-kinds-probe.tsx");
const ASYNC_BUTTON = `export const B = () => <button onClick={async () => {}}>x</button>;\n`;

async function config(rules: LintRuleSelection): Promise<Linter.Config[]> {
  return buildLintConfig({
    root: ROOT,
    typeSource: { none: true },
    exemptions: "report",
    rules,
  });
}

function registered(cfg: Linter.Config[]): string[] {
  return cfg.flatMap((b) =>
    Object.entries(b.rules ?? {})
      .filter(([, entry]) => entry !== "off")
      .map(([id]) => id),
  );
}

function verify(cfg: Linter.Config[], code: string): Linter.LintMessage[] {
  return new Linter({ configType: "flat", cwd: ROOT }).verify(code, cfg, {
    filename: PROBE,
  });
}

describe("isTypeAwareRule", () => {
  it("is true only for the literal declaration", () => {
    expect(
      isTypeAwareRule({ meta: { docs: { requiresTypeChecking: true } } }),
    ).toBe(true);
    expect(
      isTypeAwareRule({ meta: { docs: { requiresTypeChecking: "yes" } } }),
    ).toBe(false);
    expect(isTypeAwareRule({ meta: { docs: {} } })).toBe(false);
    expect(isTypeAwareRule({ create: () => ({}) })).toBe(false);
    expect(isTypeAwareRule(() => ({}))).toBe(false);
    expect(isTypeAwareRule(null)).toBe(false);
  });
});

describe("kind selection", () => {
  it("registers only the selected kind's rules", async () => {
    const typed = registered(
      await config({
        base: true,
        contributions: new Set([BUTTON_SAFETY]),
        kind: "type-aware",
      }),
    );
    expect(typed).toContain("button-safety/no-async-raw-button");
    expect(typed).not.toContain("button-safety/no-redundant-cursor-pointer");
    expect(typed).toContain("@typescript-eslint/await-thenable");
    expect(typed).not.toContain("eqeqeq");

    const syntactic = registered(
      await config({
        base: true,
        contributions: new Set([BUTTON_SAFETY]),
        kind: "syntactic",
      }),
    );
    expect(syntactic).toContain("button-safety/no-redundant-cursor-pointer");
    expect(syntactic).not.toContain("button-safety/no-async-raw-button");
    expect(syntactic).toContain("eqeqeq");
    expect(syntactic).not.toContain("@typescript-eslint/await-thenable");
  });

  it("names no rule it did not register, even in an off block", async () => {
    const cfg = await config({
      base: false,
      contributions: new Set([BUTTON_SAFETY]),
      kind: "syntactic",
    });
    const named = cfg.flatMap((b) => Object.keys(b.rules ?? {}));
    expect(named.some((id) => id === "button-safety/no-async-raw-button")).toBe(
      false,
    );
  });
});

describe("{ none: true } type source", () => {
  it("runs syntactic rules without a program", async () => {
    const cfg = await config({
      base: true,
      contributions: new Set([BUTTON_SAFETY]),
      kind: "syntactic",
    });
    expect(() => verify(cfg, ASYNC_BUTTON)).not.toThrow();
  });

  it("throws on a type-aware rule instead of passing silently", async () => {
    const cfg = await config({
      base: false,
      contributions: new Set([BUTTON_SAFETY]),
      kind: "type-aware",
    });
    expect(() => verify(cfg, ASYNC_BUTTON)).toThrow(
      /parserOptions\.project|type information/,
    );
  });
});

describe("typeAwareLintGroups", () => {
  it("names exactly the groups a type-aware selection registers a rule from", async () => {
    const groups = await typeAwareLintGroups(ROOT);
    expect(groups.base).toBe(true);
    expect(groups.contributions.has(BUTTON_SAFETY)).toBe(true);
    const cfg = await config({
      base: false,
      contributions: groups.contributions,
      kind: "type-aware",
    });
    const namespaces = new Set(
      cfg
        .flatMap((b) => Object.keys(b.plugins ?? {}))
        .filter((ns) => !["@typescript-eslint", "react-hooks"].includes(ns)),
    );
    expect(namespaces.size).toBe(groups.contributions.size);
  });
});
