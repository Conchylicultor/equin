import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliModelsError, parseInitializeModels } from "./cli-models";

// Recorded from Claude Code 2.1.287 (signed in with a subscription, no API
// key): the `initialize` answer, trimmed to the models and a few harmless
// fields — the real response also carries the account (email), commands,
// agents and output styles, none of which this reads.
const RECORDED = JSON.parse(
  readFileSync(
    join(import.meta.dir, "initialize-response.fixture.json"),
    "utf8",
  ),
) as { response: { response: { models: Record<string, unknown>[] } } };
const MODELS = RECORDED.response.response.models;

describe("parseInitializeModels", () => {
  test("reads the recorded menu: every entry's value and resolved model", () => {
    const models = parseInitializeModels(MODELS);
    expect(models).toHaveLength(12);
    expect(models.map((m) => m.value).slice(0, 5)).toEqual([
      "default",
      "opus",
      "fable",
      "sonnet",
      "haiku",
    ]);
    // Only the fields it names survive the parse.
    expect(Object.keys(models[1]!).sort()).toEqual([
      "displayName",
      "resolvedModel",
      "value",
    ]);
  });

  test("a changed shape fails loudly, naming what moved", () => {
    expect(() => parseInitializeModels(undefined)).toThrow(/changed shape/);
    const renamed = structuredClone(MODELS);
    delete renamed[0]!.resolvedModel;
    expect(() => parseInitializeModels(renamed)).toThrow(CliModelsError);
    expect(() => parseInitializeModels(renamed)).toThrow(/0\.resolvedModel/);
  });
});
