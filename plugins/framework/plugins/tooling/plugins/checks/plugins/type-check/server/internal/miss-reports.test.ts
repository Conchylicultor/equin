import { expect, test } from "bun:test";
import type { ProcessReport } from "@plugins/reports/plugins/outbox/core";
import { TypeCheckDivergencePayloadSchema } from "../../core";
import { reportMisses, type MissReportSink } from "./miss-reports";

function fakeSink(outcome: "written" | "refused"): MissReportSink & {
  filed: ProcessReport[];
} {
  const filed: ProcessReport[] = [];
  return {
    filed,
    file(report) {
      filed.push(report);
      return Promise.resolve(
        outcome === "written"
          ? { outcome, path: "/outbox/x.json" }
          : { outcome, pending: 500 },
      );
    },
    head: () => Promise.resolve("abc123"),
  };
}

test("every missed name is filed as a type-check-divergence report naming the file, the name and the commit", async () => {
  const sink = fakeSink("written");
  const lines = await reportMisses(
    [
      { file: "g.ts", name: "x" },
      { file: "k.ts", name: "k" },
    ],
    sink,
  );
  expect(sink.filed.map((r) => r.kind)).toEqual([
    "type-check-divergence",
    "type-check-divergence",
  ]);
  expect(
    sink.filed.map((r) => TypeCheckDivergencePayloadSchema.parse(r.data)),
  ).toEqual([
    { kind: "prediction", file: "g.ts", name: "x", head: "abc123" },
    { kind: "prediction", file: "k.ts", name: "k", head: "abc123" },
  ]);
  expect(lines).toEqual([
    "type-check: filed 2 type-check-divergence report(s) for the missed name(s) at abc123",
  ]);
});

test("a run with no miss files nothing; a refused report is a line, never a throw", async () => {
  const none = fakeSink("written");
  expect(await reportMisses([], none)).toEqual([]);
  expect(none.filed).toEqual([]);
  const refused = fakeSink("refused");
  const lines = await reportMisses([{ file: "g.ts", name: "x" }], refused);
  expect(lines[0]).toContain("NOT filed: g.ts#x: refused");
});
