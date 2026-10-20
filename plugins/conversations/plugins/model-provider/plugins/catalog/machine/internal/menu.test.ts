import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE_MODELS,
  ConversationModelSchema,
  cliFlagFor,
} from "@plugins/conversations/plugins/model-provider/core";
import { parseInitializeOutput, type CliModel } from "./cli-models";
import { readMenu } from "./menu";

const id = (raw: string) => ConversationModelSchema.parse(raw);
// A CLI model name spelled from the id, as everything outside the registry must.
const cliName = (raw: string) => cliFlagFor(id(raw));

const RECORDED = parseInitializeOutput({
  stdout: JSON.stringify(
    JSON.parse(
      readFileSync(
        join(import.meta.dir, "initialize-response.fixture.json"),
        "utf8",
      ),
    ),
  ),
  stderr: "",
  exitCode: 0,
  timedOut: false,
});

const alias = (value: string, resolved: string): CliModel => ({
  value,
  resolvedModel: resolved,
});

describe("readMenu", () => {
  test("the recorded menu: each family's current version, every offered version, no problem", () => {
    const menu = readMenu(RECORDED);
    expect(menu.current).toEqual({
      opus: id("opus-5-5"),
      fable: id("fable-5-1"),
      sonnet: id("sonnet-5-5"),
      haiku: id("haiku-4-5"),
    });
    // Exactly the baseline: the versions this code shipped knowing.
    expect([...menu.offered].sort()).toEqual(
      BASELINE_MODELS.versions.map((v) => v.id).sort(),
    );
    expect(menu.problems).toEqual([]);
  });

  test("`default` is ignored: it is the CLI's pick of a family, not one", () => {
    const menu = readMenu([alias("default", cliName("opus-9"))]);
    expect(menu.offered).toEqual([]);
    expect(menu.current).toEqual({});
  });

  test("an unknown alias, a name outside the grammar, a cross-family alias: reported, nothing placed", () => {
    const menu = readMenu([
      ...RECORDED,
      alias("mythos", "claude-mythos-1"),
      alias("sonnet-latest", cliName("sonnet-9")),
      alias("claude-3-5-sonnet", "claude-3-5-sonnet-20241022"),
    ]);
    expect(menu.problems).toEqual([
      {
        problem: "unknown-alias",
        value: "mythos",
        resolvedModel: "claude-mythos-1",
      },
      {
        problem: "unknown-alias",
        value: "sonnet-latest",
        resolvedModel: cliName("sonnet-9"),
      },
      {
        problem: "unknown-alias",
        value: "claude-3-5-sonnet",
        resolvedModel: "claude-3-5-sonnet-20241022",
      },
    ]);
    expect(menu.offered).not.toContain(id("sonnet-9"));

    const renamed = readMenu([
      alias("opus", "claude-opus-next"),
      alias("sonnet", cliName("opus-9")),
    ]);
    expect(renamed.problems.slice(0, 2)).toEqual([
      {
        problem: "not-a-model-id",
        value: "opus",
        resolvedModel: "claude-opus-next",
      },
      {
        problem: "family-mismatch",
        value: "sonnet",
        resolvedModel: cliName("opus-9"),
      },
    ]);
    expect(renamed.current).toEqual({});
    expect(renamed.offered).toEqual([]);
  });

  test("a family the menu leaves out is reported", () => {
    const menu = readMenu(RECORDED.filter((m) => m.value !== "haiku"));
    expect(menu.current.haiku).toBeUndefined();
    expect(menu.problems).toEqual([
      { problem: "family-missing", value: "haiku", resolvedModel: null },
    ]);
  });
});
