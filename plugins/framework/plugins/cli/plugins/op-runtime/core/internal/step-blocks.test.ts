import { describe, expect, test } from "bun:test";
import { parseStepBlocks, renderStepBlock } from "./step-blocks";

function rendered(
  label: string,
  success: boolean,
  durationMs: number,
  lines: string[],
): string[] {
  return renderStepBlock({
    id: label,
    label,
    success,
    durationMs,
    lines: lines.map((text) => ({ text, stream: "stdout" as const })),
  }).map((l) => l.text);
}

describe("parseStepBlocks", () => {
  test("reads back what renderStepBlock prints, and the output around it", () => {
    const lines = [
      "Generating plugin registry...",
      ...rendered("checks", true, 25834, ["• a ... ok", "⚠ stalled"]),
      ...rendered("web artifacts", false, 1234, ["✓ built"]),
      "Restarting backend...",
    ];
    expect(parseStepBlocks(lines)).toEqual([
      { kind: "output", lines: ["Generating plugin registry..."] },
      {
        kind: "step",
        label: "checks",
        success: true,
        durationMs: 25800,
        lines: ["• a ... ok", "⚠ stalled"],
      },
      {
        kind: "step",
        label: "web artifacts",
        success: false,
        durationMs: 1200,
        lines: ["✓ built"],
      },
      { kind: "output", lines: ["Restarting backend..."] },
    ]);
  });

  test("a label longer than the rule width still parses", () => {
    const label = "x".repeat(80);
    expect(parseStepBlocks(rendered(label, true, 0, []))).toEqual([
      { kind: "step", label, success: true, durationMs: 0, lines: [] },
    ]);
  });

  test("a quoted line outside any block is output, not a step line", () => {
    expect(parseStepBlocks(["│ stray"])).toEqual([
      { kind: "output", lines: ["│ stray"] },
    ]);
  });

  test("no lines, no segments", () => {
    expect(parseStepBlocks([])).toEqual([]);
  });
});
