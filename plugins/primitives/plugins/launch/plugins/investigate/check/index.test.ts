import { describe, expect, test } from "bun:test";
import { unregisteredFailures } from "./index";

// Fixture files of made-up plugins `a` and `b`.
const file = (plugin: string, path: string, src: string) => ({
  rel: `plugins/${plugin}/${path}`,
  src,
});

const META =
  'export const OUTCOME_META = {\n  ok: { label: "Ok", variant: "success" },\n  failed: { label: "Failed", variant: "destructive" },\n};\n';
const FIELDS =
  'import { OUTCOME_META } from "./meta";\nexport const runFields = {\n  outcome: enumTextField(OUTCOMES, { label: "Outcome", options: OUTCOME_META }),\n};\n';
const COLLECTION =
  'import { runFields } from "./fields";\nexport const runsList = liveCollection("a.runs", {\n  fields: runFields,\n  id: "id",\n  default: { orderBy: [["startedAt", "desc"]], limit: 100 },\n  maxLimit: 500,\n});\n';
const REGISTER =
  'import { runsList } from "../core";\nexport const c = Investigate.Register({ owner: runsList, failed: () => true });\n';

const names = (r: { name: string }[]) => r.map((m) => m.name);

describe("investigate:failures-registered", () => {
  test("a tint reached through a chain of imported constants is flagged until registered", () => {
    const constants = [
      file("a", "core/meta.ts", META),
      file("a", "core/fields.ts", FIELDS),
    ];
    const declaring = [file("a", "core/index.ts", COLLECTION)];
    expect(names(unregisteredFailures(declaring, constants, []))).toEqual([
      "runsList",
    ]);
    expect(
      unregisteredFailures(declaring, constants, [
        file("a", "web/index.ts", REGISTER),
      ]),
    ).toEqual([]);
  });

  test("a helper exported from a file calling Investigate.Register counts as a registration", () => {
    const helper =
      "export function investigateIt(owner) {\n  return Investigate.Register({ owner });\n}\n";
    const use =
      'import { runsList as rl } from "../core";\nconst c = investigateIt(rl, { noun: "run" });\n';
    expect(
      unregisteredFailures(
        [file("a", "core/index.ts", COLLECTION)],
        [file("a", "core/meta.ts", META), file("a", "core/fields.ts", FIELDS)],
        [file("b", "web/helper.ts", helper), file("a", "web/index.ts", use)],
      ),
    ).toEqual([]);
  });

  test("an untinted collection, a lookup-only one and a same-named local constant are not flagged", () => {
    const plain =
      'export const quiet = liveCollection("a.quiet", {\n  fields: { s: enumTextField(S, { options: { x: { label: "X", variant: "muted" } } }) },\n  default: { limit: 10 },\n});\n';
    const lookup =
      'export const byId = liveCollection("a.by-id", {\n  row: z.object({ s: z.string() }),\n  id: "id",\n  options: { failed: { variant: "destructive" } },\n});\n';
    // `runFields` here is ITS OWN local constant, not the tinted export.
    const shadow =
      'const runFields = { n: intField() };\nexport const other = liveCollection("b.other", { fields: runFields, default: { limit: 10 } });\n';
    expect(
      unregisteredFailures(
        [
          file("a", "core/quiet.ts", plain),
          file("a", "core/by-id.ts", lookup),
          file("b", "core/index.ts", shadow),
        ],
        [file("a", "core/meta.ts", META), file("a", "core/fields.ts", FIELDS)],
        [],
      ),
    ).toEqual([]);
  });

  test("a tinted union is answered by its arms: the union is never flagged, every arm is", () => {
    const union =
      'import { runFields } from "./fields";\nexport const all = liveCollection("a.all", {\n  fields: runFields,\n  arms: { discriminator: "kind" },\n  default: { limit: 10 },\n});\n';
    const arm =
      'import { all } from "@plugins/a/core";\nexport const bArm = liveArm(all, "b", { label: "B", fields: {} });\n';
    const constants = [
      file("a", "core/meta.ts", META),
      file("a", "core/fields.ts", FIELDS),
    ];
    const declaring = [
      file("a", "core/union.ts", union),
      file("b", "core/index.ts", arm),
    ];
    expect(names(unregisteredFailures(declaring, constants, []))).toEqual([
      "bArm",
    ]);
    const reg =
      'import { bArm } from "../core";\nconst c = Investigate.Register({ owner: bArm });\n';
    expect(
      unregisteredFailures(declaring, constants, [
        file("b", "web/index.ts", reg),
      ]),
    ).toEqual([]);
  });
});
