import { describe, expect, it } from "vitest";
import { parseStructuredTag } from "../internal/parse-structured-tag";

describe("parseStructuredTag", () => {
  it("parses a task-notification block into ordered fields", () => {
    const text = `<task-notification>
<task-id>b4fy5q2ui</task-id>
<tool-use-id>toolu_01Ss356aqKriGj8vrpZ6A9kU</tool-use-id>
<output-file>/tmp/out.output</output-file>
<status>completed</status>
<summary>Monitor "equin push to main" stream ended</summary>
</task-notification>`;

    const parsed = parseStructuredTag(text);
    expect(parsed?.tag).toBe("task-notification");
    expect(parsed?.fields.map((f) => f.key)).toEqual([
      "task-id",
      "tool-use-id",
      "output-file",
      "status",
      "summary",
    ]);
    expect(parsed?.fields.find((f) => f.key === "status")?.value).toBe("completed");
    expect(parsed?.fields.find((f) => f.key === "summary")?.value).toBe(
      'Monitor "equin push to main" stream ended',
    );
  });

  it("keeps unknown / newly added fields (nothing silenced)", () => {
    const parsed = parseStructuredTag(
      "<some-future-event><foo>1</foo><brand-new-field>2</brand-new-field></some-future-event>",
    );
    expect(parsed?.tag).toBe("some-future-event");
    expect(parsed?.fields.map((f) => f.key)).toEqual(["foo", "brand-new-field"]);
  });

  it("returns null for plain prose", () => {
    expect(parseStructuredTag("just a normal queued message")).toBeNull();
  });

  it("returns null for a bare tag wrapping plain text (no child fields)", () => {
    expect(parseStructuredTag("<note>hello there</note>")).toBeNull();
  });

  it("returns null for malformed XML rather than mangling it", () => {
    expect(parseStructuredTag("<task-notification><status>oops</task-notification>")).toBeNull();
  });

  it("returns null when surrounded by prose", () => {
    expect(parseStructuredTag("see <task-notification><status>x</status></task-notification> now")).toBeNull();
  });
});
