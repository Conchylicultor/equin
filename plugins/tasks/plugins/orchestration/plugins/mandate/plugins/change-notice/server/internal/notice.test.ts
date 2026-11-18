import { describe, expect, it } from "bun:test";
import { MANDATE_CHANGE_LEAD, noticeText } from "./notice";

describe("noticeText", () => {
  it("carries every picked section, not just the Mandate", () => {
    const text = noticeText(MANDATE_CHANGE_LEAD, [
      { kind: "current", id: "mandate", label: "Mandate", text: "<m/>" },
      {
        kind: "current",
        id: "supervisor-prompt",
        label: "Supervisor prompt",
        text: "<s/>",
      },
    ]);
    expect(text.startsWith(MANDATE_CHANGE_LEAD)).toBe(true);
    expect(text).toContain("<m/>\n\n<s/>");
    expect(text).not.toContain("No longer apply");
  });

  it("names the sections that no longer apply", () => {
    const text = noticeText(MANDATE_CHANGE_LEAD, [
      {
        kind: "withdrawn",
        id: "supervisor-prompt",
        label: "Supervisor prompt",
      },
    ]);
    expect(text).toContain("(none apply now");
    expect(text).toContain("- Supervisor prompt (`supervisor-prompt`)");
  });

  it("leads with what changed", () => {
    const text = noticeText("The roles changed.", [
      { kind: "current", id: "supervisor-roles", label: "Roles", text: "<r/>" },
    ]);
    expect(text.split("\n")[0]).toBe("The roles changed.");
    expect(text).toContain("<r/>");
  });
});
