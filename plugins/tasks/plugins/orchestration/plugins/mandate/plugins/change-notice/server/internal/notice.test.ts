import { describe, expect, it } from "bun:test";
import {
  MANDATE_CHANGE_LEAD,
  noticeText,
  routeMandateChange,
  runHandedOverLead,
  sideChatMandateNote,
} from "./notice";

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

describe("routeMandateChange", () => {
  const live = [
    { id: "runner", taskId: "T", mandateRef: null },
    { id: "side", taskId: "T", mandateRef: "interactive" },
    { id: "other", taskId: "U", mandateRef: null },
  ];

  it("sends the sections only to the conversation running the task", () => {
    const { follows, side } = routeMandateChange(live, new Set(["T"]));
    expect(follows.map((c) => c.id)).toEqual(["runner"]);
    expect(side.map((c) => c.id)).toEqual(["side"]);
  });

  it("a side chat is told nothing changed for it, naming both mandates", () => {
    const text = sideChatMandateNote("Supervisor", "Interactive");
    expect(text).toContain("to Supervisor");
    expect(text).toContain("keeps working as Interactive");
    expect(text).toContain("NOT a request to act");
  });

  it("a hand-over names the mandate the conversation now works under", () => {
    expect(runHandedOverLead("Supervisor")).toContain(
      "your task's mandate — Supervisor —",
    );
  });
});
