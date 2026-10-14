import { describe, expect, test } from "bun:test";
import {
  inventorySinks,
  readConsumer,
  scanSinkCalls,
  type RawSinkCall,
  type ResolvedSinkCall,
} from "./scan";

const resolveLiterals = (calls: RawSinkCall[]): ResolvedSinkCall[] =>
  calls.map((c) => ({
    marker: c.marker,
    path: c.path,
    line: c.line,
    id: c.id.kind === "literal" ? c.id.value : null,
  }));

const LOG_TS = "plugins/primitives/plugins/log-channels/server/internal/log.ts";
const skipsLog = (path: string): boolean => path === LOG_TS;

describe("scanSinkCalls", () => {
  test("finds a multi-line defineFileSink call and reads its literal id", () => {
    const src = [
      'import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";',
      '// defineFileSink({ id: "commented" }) is not a call',
      'const note = "defineFileSink({ id: \\"stringed\\" })";',
      "const sink = defineFileSink({",
      '  id: "my-sink",',
      '  description: "d",',
      '  consumer: { kind: "internal", note: "n" },',
      "  path: P,",
      "});",
    ].join("\n");
    const calls = scanSinkCalls([{ rel: "a.ts", src }], "defineFileSink");
    expect(calls).toEqual([
      {
        marker: "defineFileSink",
        path: "a.ts",
        line: 4,
        id: { kind: "literal", value: "my-sink" },
        consumer: { kind: "inline", reportKind: null, timelineSource: null },
      },
    ]);
  });

  test("skips the primitive's own signature, classifies const and computed ids", () => {
    const src = [
      "export function defineFileSink(spec: FileSinkSpec): FileSink {}",
      "defineFileSink({ id: MY_CONST, path: P });",
      "defineFileSink({ id: spec.id, path: P });",
      "defineFileSink({ path: P });",
    ].join("\n");
    const ids = scanSinkCalls([{ rel: "b.ts", src }], "defineFileSink").map(
      (c) => c.id.kind,
    );
    expect(ids).toEqual(["const", "computed", "computed"]);
  });
});

describe("inventorySinks", () => {
  test("an exempted computed id is excused; an unexempted one is unresolvable", () => {
    const computed = "defineFileSink({ id: spec.id, path: P });";
    const calls = resolveLiterals([
      ...scanSinkCalls([{ rel: LOG_TS, src: computed }], "defineFileSink"),
      ...scanSinkCalls([{ rel: "other.ts", src: computed }], "defineFileSink"),
    ]);
    const inv = inventorySinks(calls, skipsLog);
    expect(inv.unresolvable.map((s) => s.path)).toEqual(["other.ts"]);
  });

  test("skips is offered only a computed id, never a literal one", () => {
    const literalOnly = 'defineFileSink({ id: "fixed", path: P });';
    const calls = resolveLiterals(
      scanSinkCalls([{ rel: LOG_TS, src: literalOnly }], "defineFileSink"),
    );
    const asked: string[] = [];
    const inv = inventorySinks(calls, (p) => (asked.push(p), true));
    expect(asked).toEqual([]);
    expect(inv.unresolvable).toEqual([]);
  });

  test("one id through both primitives is a collision", () => {
    const calls = resolveLiterals([
      ...scanSinkCalls(
        [
          {
            rel: "log.ts",
            src: 'defineLogSink({ id: "dup", description: "d" });',
          },
        ],
        "defineLogSink",
      ),
      ...scanSinkCalls(
        [{ rel: "file.ts", src: 'defineFileSink({ id: "dup", path: P });' }],
        "defineFileSink",
      ),
    ]);
    const inv = inventorySinks(calls, () => false);
    expect(inv.collisions.map((c) => c.id)).toEqual(["dup"]);
  });
});

describe("readConsumer", () => {
  test("reads report and timeline references from an inline object", () => {
    expect(
      readConsumer(
        '{ id: "boot", consumer: { kind: "report", reportKind: "boot-wedge", timelineSource: BOOT_SOURCE, note: "x" } }',
      ),
    ).toEqual({
      kind: "inline",
      reportKind: { kind: "literal", value: "boot-wedge" },
      timelineSource: { kind: "const", name: "BOOT_SOURCE" },
    });
  });

  test("a consumer: inside a string or comment never matches", () => {
    expect(
      readConsumer(
        '{ id: "a", description: "consumer: { x }" /* consumer: {} */ }',
      ),
    ).toEqual({ kind: "opaque", expr: null });
  });

  test("a non-literal consumer is opaque, so it cannot dodge validation", () => {
    expect(readConsumer('{ id: "a", consumer: SHARED, path: P }')).toEqual({
      kind: "opaque",
      expr: "SHARED",
    });
  });

  test("a note mentioning reportKind does not read as one", () => {
    expect(
      readConsumer(
        '{ consumer: { kind: "internal", note: "no reportKind: here" } }',
      ),
    ).toEqual({ kind: "inline", reportKind: null, timelineSource: null });
  });
});
