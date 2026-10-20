import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { agentCallJoin, describedSubagent } from "./protocol";
import { agentCallForSubagent } from "./join";
import type { SubagentActivityRow } from "./protocol";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

const agentCall = (toolUseId: string, input: unknown): ToolCallEvent => ({
  kind: "tool-call",
  at: "2026-09-20T10:00:00.000Z",
  toolUseId,
  name: "Agent",
  input,
});

const row = (
  over: Partial<SubagentActivityRow> & { agentId: string },
): SubagentActivityRow =>
  ({
    kind: "described",
    agentType: "Explore",
    description: "work",
    startedAt: "2026-09-20T10:00:00.000Z",
    lastActivityAt: "2026-09-20T10:01:00.000Z",
    turnEnded: false,
    newestTurnLineAt: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    lastStep: null,
    ...over,
  }) as SubagentActivityRow;

describe("agentCallJoin", () => {
  test("an ordinary Agent call offers only its id", () => {
    expect(
      agentCallJoin(agentCall("toolu_1", { subagent_type: "Explore" })),
    ).toEqual({
      toolUseId: "toolu_1",
      requestedName: undefined,
    });
  });

  test("a NAMED Agent call also offers the name, which is the teammate's only key", () => {
    expect(agentCallJoin(agentCall("toolu_1", { name: "live-probe" }))).toEqual(
      {
        toolUseId: "toolu_1",
        requestedName: "live-probe",
      },
    );
  });

  test("an empty or non-string name is no name", () => {
    expect(
      agentCallJoin(agentCall("toolu_1", { name: "" })).requestedName,
    ).toBeUndefined();
    expect(
      agentCallJoin(agentCall("toolu_1", { name: 7 })).requestedName,
    ).toBeUndefined();
    expect(
      agentCallJoin(agentCall("toolu_1", null)).requestedName,
    ).toBeUndefined();
  });
});

describe("describedSubagent", () => {
  test("an id match wins, and is not disturbed by a name", () => {
    const rows = [
      row({ agentId: "a", toolUseId: "toolu_1" }),
      row({ agentId: "b", name: "n" }),
    ];
    expect(
      describedSubagent(rows, { toolUseId: "toolu_1", requestedName: "n" })
        ?.agentId,
    ).toBe("a");
  });

  test("a named teammate joins on the name when no meta records the id", () => {
    // The gap this closes: the card exists and has an id, the meta has only a
    // name, so an id-only join found nothing and the card showed nothing.
    const rows = [row({ agentId: "mate", name: "live-probe" })];
    expect(
      describedSubagent(rows, {
        toolUseId: "toolu_x",
        requestedName: "live-probe",
      })?.agentId,
    ).toBe("mate");
  });

  test("a row that has its own id is never claimed by someone else's name", () => {
    const rows = [
      row({ agentId: "owned", toolUseId: "toolu_owner", name: "live-probe" }),
    ];
    expect(
      describedSubagent(rows, {
        toolUseId: "toolu_x",
        requestedName: "live-probe",
      }),
    ).toBeUndefined();
  });

  test("two rows answering to one name refuse to join, rather than guess", () => {
    const rows = [
      row({ agentId: "first", name: "twin" }),
      row({ agentId: "second", name: "twin" }),
    ];
    expect(
      describedSubagent(rows, { toolUseId: "toolu_x", requestedName: "twin" }),
    ).toBeUndefined();
  });

  test("an undescribed row is never joined to a card", () => {
    const rows: SubagentActivityRow[] = [
      {
        kind: "undescribed",
        agentId: "broken",
        reason: "not valid JSON",
        startedAt: "2026-09-20T10:00:00.000Z",
        lastActivityAt: "2026-09-20T10:01:00.000Z",
        turnEnded: false,
        newestTurnLineAt: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        lastStep: null,
      },
    ];
    expect(
      describedSubagent(rows, { toolUseId: "toolu_x", requestedName: "n" }),
    ).toBeUndefined();
  });

  test("no name offered and no id match is simply no row", () => {
    expect(
      describedSubagent([row({ agentId: "a", name: "n" })], {
        toolUseId: "toolu_x",
      }),
    ).toBeUndefined();
  });
});

describe("agentCallForSubagent", () => {
  const calls = [
    agentCall("toolu_1", { subagent_type: "Explore" }),
    agentCall("toolu_2", { name: "live-probe" }),
  ];

  test("a row carrying an id joins to the call with that id", () => {
    expect(
      agentCallForSubagent(row({ agentId: "a", toolUseId: "toolu_1" }), calls)
        ?.toolUseId,
    ).toBe("toolu_1");
  });

  test("a named teammate joins to the call that asked for its name", () => {
    // The teammate's meta records no tool-use id at all, so the name is the
    // only key it has — and without the call there is no completion signal.
    expect(
      agentCallForSubagent(row({ agentId: "mate", name: "live-probe" }), calls)
        ?.toolUseId,
    ).toBe("toolu_2");
  });

  test("a row whose call is not in the transcript joins to nothing", () => {
    expect(
      agentCallForSubagent(row({ agentId: "a", toolUseId: "gone" }), calls),
    ).toBeUndefined();
    expect(
      agentCallForSubagent(row({ agentId: "a", name: "unnamed-here" }), calls),
    ).toBeUndefined();
  });

  test("two calls asking for one name refuse to join, rather than guess", () => {
    const twins = [
      agentCall("toolu_a", { name: "twin" }),
      agentCall("toolu_b", { name: "twin" }),
    ];
    expect(
      agentCallForSubagent(row({ agentId: "a", name: "twin" }), twins),
    ).toBeUndefined();
  });

  test("an undescribed row has no key to join on", () => {
    const broken: SubagentActivityRow = {
      kind: "undescribed",
      agentId: "broken",
      reason: "not valid JSON",
      startedAt: "2026-09-20T10:00:00.000Z",
      lastActivityAt: "2026-09-20T10:01:00.000Z",
      turnEnded: false,
      newestTurnLineAt: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      lastStep: null,
    };
    expect(agentCallForSubagent(broken, calls)).toBeUndefined();
  });

  test("a row with no id and no name joins to nothing", () => {
    expect(agentCallForSubagent(row({ agentId: "a" }), calls)).toBeUndefined();
  });
});
