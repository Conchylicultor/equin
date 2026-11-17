import { describe, expect, it } from "bun:test";
import { noticeText } from "./notice";

describe("noticeText", () => {
  it("carries every mandate-following section, not just the Mandate", () => {
    const text = noticeText([
      { kind: "current", id: "mandate", label: "Mandate", text: "<m/>" },
      {
        kind: "current",
        id: "supervisor-prompt",
        label: "Supervisor prompt",
        text: "<s/>",
      },
    ]);
    expect(text).toContain("<m/>\n\n<s/>");
    expect(text).not.toContain("No longer apply");
  });

  it("names the sections that no longer apply", () => {
    const text = noticeText([
      {
        kind: "withdrawn",
        id: "supervisor-prompt",
        label: "Supervisor prompt",
      },
    ]);
    expect(text).toContain("(none apply now");
    expect(text).toContain("- Supervisor prompt (`supervisor-prompt`)");
  });
});
