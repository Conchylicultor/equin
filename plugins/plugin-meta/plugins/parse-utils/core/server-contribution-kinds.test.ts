import { describe, expect, test } from "bun:test";
import { parseServerContributionDeclarations } from "./server-contribution-kinds";

describe("parseServerContributionDeclarations", () => {
  test("reads each literal kind, its binding, absentOnHost and companions", () => {
    expect(
      parseServerContributionDeclarations(`
export const A = defineServerContribution<{ id: string }>("a.kind", { docLabel: (p) => p.id });
export const B = defineServerContribution<{ restore(id: string): Promise<string> }>(
  "b.kind",
  { absentOnHost: { reason: "a reaction" } },
);
const C = defineServerContribution<{ reason: string }>("c.kind", {
  companions: true,
  docLabel: (p) => p.reason,
});
// defineServerContribution("in.a.comment", { companions: true })
const s = 'defineServerContribution("in.a.string", { companions: 1 })';
export function defineServerContribution<P>(debugName: string, opts: { companions: true }) {}
`),
    ).toEqual([
      { kind: "a.kind", binding: "A", absentOnHost: false, companions: false },
      { kind: "b.kind", binding: "B", absentOnHost: true, companions: false },
      { kind: "c.kind", binding: "C", absentOnHost: false, companions: true },
    ]);
  });

  test("a nested `companions:` is not the kind's option", () => {
    expect(
      parseServerContributionDeclarations(
        `export const N = defineServerContribution<X>("n.kind", { docLabel: (p) => ({ companions: true }).x });`,
      ),
    ).toEqual([
      { kind: "n.kind", binding: "N", absentOnHost: false, companions: false },
    ]);
  });

  test("a `companions` it cannot act on throws, naming the file", () => {
    expect(() =>
      parseServerContributionDeclarations(
        `export const X = defineServerContribution<P>("x", { companions: flag });`,
        "fixture/server/x.ts",
      ),
    ).toThrow(/fixture\/server\/x\.ts:1: .*must be the literal `true`/);
    expect(() =>
      parseServerContributionDeclarations(
        `export const X = defineServerContribution<P>(name, { companions: true });`,
      ),
    ).toThrow(/must be named by a string literal/);
    expect(() =>
      parseServerContributionDeclarations(
        `register(defineServerContribution<P>("x", { companions: true }));`,
      ),
    ).toThrow(/must be bound to a `const`/);
  });
});
