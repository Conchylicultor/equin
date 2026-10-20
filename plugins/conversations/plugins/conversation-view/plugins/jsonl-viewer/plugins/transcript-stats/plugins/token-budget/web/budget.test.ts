import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  isTotalTokensReminder,
  parseBudgetAttachment,
  parseBudgetText,
  readBudget,
} from "./budget";

function reminder(remaining: number): JsonlEvent {
  return {
    kind: "attachment",
    at: `t${remaining}`,
    subtype: "total_tokens_reminder",
    attachment: {
      type: "total_tokens_reminder",
      text: `<total_tokens>${remaining} tokens left</total_tokens>`,
    },
  };
}

describe("parseBudgetText", () => {
  test("reads the number out of the harness's wording", () => {
    expect(
      parseBudgetText("<total_tokens>15000000 tokens left</total_tokens>"),
    ).toEqual({ ok: true, remaining: 15_000_000 });
  });

  test("tolerates thousands separators and stray whitespace", () => {
    expect(
      parseBudgetText("<total_tokens> 14,912,164 tokens left </total_tokens>"),
    ).toEqual({ ok: true, remaining: 14_912_164 });
  });

  test("unreadable wording surfaces the raw text instead of a number", () => {
    expect(parseBudgetText("<total_tokens>plenty</total_tokens>")).toEqual({
      ok: false,
      raw: "<total_tokens>plenty</total_tokens>",
    });
  });
});

describe("parseBudgetAttachment", () => {
  test("a payload with no readable text is not a budget", () => {
    expect(parseBudgetAttachment({ type: "total_tokens_reminder" }).ok).toBe(
      false,
    );
    expect(parseBudgetAttachment(null).ok).toBe(false);
  });
});

describe("isTotalTokensReminder", () => {
  test("matches only the harness's budget reminder", () => {
    expect(isTotalTokensReminder(reminder(1))).toBe(true);
    expect(
      isTotalTokensReminder({
        kind: "attachment",
        at: "t",
        subtype: "date_change",
        attachment: {},
      }),
    ).toBe(false);
    expect(
      isTotalTokensReminder({ kind: "user-text", at: "t", text: "hi" }),
    ).toBe(false);
  });
});

describe("readBudget", () => {
  test("a stretch with no reminder has nothing to report", () => {
    expect(readBudget([])).toBeNull();
    expect(readBudget([{ kind: "user-text", at: "t", text: "hi" }])).toBeNull();
  });

  test("reports what got charged, and against which allowance", () => {
    expect(readBudget([reminder(1000), reminder(900), reminder(250)])).toEqual({
      spent: 750,
      spentThisRequest: 750,
      requests: 1,
      allowance: 1000,
    });
  });

  test("the first reading has spent nothing yet", () => {
    expect(readBudget([reminder(1000)])).toEqual({
      spent: 0,
      spentThisRequest: 0,
      requests: 1,
      allowance: 1000,
    });
  });

  test("a re-anchor does not erase what earlier requests already spent", () => {
    // 1000 → 250 (750 charged), allowance re-anchored to 1000, → 900 (100 more).
    // `first - last` would claim 100; summing the drops keeps both requests.
    expect(
      readBudget([
        reminder(1000),
        reminder(250),
        reminder(1000),
        reminder(900),
      ]),
    ).toEqual({
      spent: 850,
      spentThisRequest: 100,
      requests: 2,
      allowance: 1000,
    });
  });

  test("a request that has only just started still reports the total", () => {
    // The very state that made "left" useless: back on the ceiling, nothing
    // spent in this request, and 750 spent by the conversation all the same.
    expect(readBudget([reminder(1000), reminder(250), reminder(1000)])).toEqual(
      {
        spent: 750,
        spentThisRequest: 0,
        requests: 2,
        allowance: 1000,
      },
    );
  });

  test("unreadable reminders are skipped, not counted as zero left", () => {
    const broken: JsonlEvent = {
      kind: "attachment",
      at: "t-broken",
      subtype: "total_tokens_reminder",
      attachment: { type: "total_tokens_reminder", text: "who knows" },
    };
    expect(readBudget([reminder(1000), broken, reminder(400)])).toEqual({
      spent: 600,
      spentThisRequest: 600,
      requests: 1,
      allowance: 1000,
    });
  });

  test("a transcript starting mid-request measures against what it can see", () => {
    // No re-anchor in view, so the largest reading is the only ceiling there is
    // — and what this request spent before the stretch began is unknowable.
    expect(readBudget([reminder(400), reminder(150)])).toEqual({
      spent: 250,
      spentThisRequest: 250,
      requests: 1,
      allowance: 400,
    });
  });

  test("an exhausted allowance is a full charge, never a divide-by-zero", () => {
    expect(readBudget([reminder(1000), reminder(0)])).toEqual({
      spent: 1000,
      spentThisRequest: 1000,
      requests: 1,
      allowance: 1000,
    });
  });
});
