import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliModelsError,
  INITIALIZE_ARGS,
  INITIALIZE_REQUEST,
  parseInitializeOutput,
  readCliModels,
} from "./cli-models";

// Recorded from Claude Code 2.1.287 (signed in with a subscription, no API
// key): the one line the CLI printed for `initialize`, trimmed to the models
// and a few harmless fields — the real response also carries the account
// (email), commands, agents and output styles, none of which this reads.
const RECORDED = JSON.parse(
  readFileSync(
    join(import.meta.dir, "initialize-response.fixture.json"),
    "utf8",
  ),
) as { response: { response: { models: unknown[] } } };
const RECORDED_LINE = JSON.stringify(RECORDED);

const output = (stdout: string, exitCode = 0) => ({
  stdout,
  stderr: "",
  exitCode,
  timedOut: false,
});

describe("parseInitializeOutput", () => {
  test("reads the recorded menu: every entry's value and resolved model", () => {
    const models = parseInitializeOutput(output(`${RECORDED_LINE}\n`));
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
    const drifted = structuredClone(RECORDED) as {
      response: { response: Record<string, unknown> };
    };
    drifted.response.response = {
      modelOptions: RECORDED.response.response.models,
    };
    expect(() =>
      parseInitializeOutput(output(JSON.stringify(drifted))),
    ).toThrow(/changed shape \(response\.response\.models/);

    const renamed = structuredClone(RECORDED) as {
      response: { response: { models: Record<string, unknown>[] } };
    };
    delete renamed.response.response.models[0]!.resolvedModel;
    expect(() =>
      parseInitializeOutput(output(JSON.stringify(renamed))),
    ).toThrow(CliModelsError);
  });

  test("a refused initialize, no answer, or a timeout is an error, never an empty menu", () => {
    const refused = JSON.stringify({
      type: "control_response",
      response: { subtype: "error", request_id: "init-1", error: "nope" },
    });
    expect(() => parseInitializeOutput(output(refused))).toThrow(
      /refused initialize: nope/,
    );
    expect(() =>
      parseInitializeOutput({
        stdout: "",
        stderr: "Error: boom",
        exitCode: 1,
        timedOut: false,
      }),
    ).toThrow(/exited 1 with no control_response: Error: boom/);
    expect(() =>
      parseInitializeOutput({ ...output(""), timedOut: true }),
    ).toThrow(/no answer/);
  });
});

describe("readCliModels against a fake claude", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-model-menu-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("passes the stream-json argv, writes the initialize request on stdin, reads the answer", async () => {
    const answer = join(dir, "answer.json");
    writeFileSync(answer, `${RECORDED_LINE}\n`);
    const expectedStdin = join(dir, "expected-stdin");
    writeFileSync(expectedStdin, INITIALIZE_REQUEST);
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        // Answers only to exactly the argv and the request discovery sends.
        `[ "$*" = "${INITIALIZE_ARGS.join(" ")}" ] || { echo "argv: $*" >&2; exit 3; }`,
        `cat > "${dir}/stdin"`,
        `cmp -s "${dir}/stdin" "${expectedStdin}" || { echo "stdin differs" >&2; exit 4; }`,
        `cat "${answer}"`,
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    const models = await readCliModels(bin, new AbortController().signal);
    expect(models.find((m) => m.value === "sonnet")?.displayName).toBe(
      "Sonnet 5.5",
    );
  });
});
