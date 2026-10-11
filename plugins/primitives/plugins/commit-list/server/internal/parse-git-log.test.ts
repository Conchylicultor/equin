import { describe, expect, test } from "bun:test";
import { parseGitLog } from "./parse-git-log";

function record(fields: { trailers: string; subject: string }): string {
  return (
    [
      "a".repeat(40),
      "aaaaaaa",
      "b".repeat(40),
      "Ada",
      "ada@example.com",
      "2026-10-01T12:00:00+00:00",
      fields.trailers,
      fields.subject,
    ].join("\t") + "\0"
  );
}

describe("parseGitLog", () => {
  test("reads every trailer, in message order", () => {
    const [row] = parseGitLog(
      record({
        trailers:
          "Singularity-Conversation\x1econv-1\x1fCo-Authored-By\x1eA: <a@b.c>",
        subject: "feat: x",
      }),
    );
    expect(row?.trailers).toEqual([
      { key: "Singularity-Conversation", value: "conv-1" },
      { key: "Co-Authored-By", value: "A: <a@b.c>" },
    ]);
    expect(row?.subject).toBe("feat: x");
  });

  test("a message without trailers has none, and a tab in the subject survives", () => {
    const rows = parseGitLog(
      record({ trailers: "", subject: "one\ttwo" }) +
        "\n" +
        record({ trailers: "", subject: "three" }),
    );
    expect(rows.map((r) => r.trailers)).toEqual([[], []]);
    expect(rows.map((r) => r.subject)).toEqual(["one\ttwo", "three"]);
  });
});
