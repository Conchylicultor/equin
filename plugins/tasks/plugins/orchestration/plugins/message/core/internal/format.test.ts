import { describe, expect, test } from "bun:test";
import {
  DELIVERIES,
  formatMessageAnswer,
  readMessageAnswer,
  type Delivery,
} from "./answer";
import { formatAgentList, readAgentList, type AgentLine } from "./agent-list";

describe("message_agent's answer", () => {
  test("every delivery reads back as written", () => {
    for (const delivery of Object.keys(DELIVERIES) as Delivery[]) {
      const answer = {
        kind: "sent",
        conversationId: "conv-1",
        delivery,
      } as const;
      expect(readMessageAnswer(formatMessageAnswer(answer))).toEqual(answer);
    }
  });

  test("a refusal reads back with its message", () => {
    const answer = { kind: "not-sent", message: "conv-1 has closed." } as const;
    expect(readMessageAnswer(formatMessageAnswer(answer))).toEqual(answer);
  });

  test("an answer in another shape stays text", () => {
    expect(readMessageAnswer("Sent to conv-1: something new.")).toEqual({
      kind: "text",
      text: "Sent to conv-1: something new.",
    });
  });
});

describe("list_agents' answer", () => {
  const agents: AgentLine[] = [
    {
      taskId: "task-1",
      title: 'Diagnose "slow" builds',
      conversationId: "conv-1",
      standing: "idle (hibernated)",
      self: false,
    },
    {
      taskId: "task-2",
      title: "Other",
      conversationId: "conv-2",
      standing: "working · status unverified",
      self: true,
    },
  ];

  test("a written list reads back as written, its tail as text", () => {
    expect(readAgentList(formatAgentList(agents, 2))).toEqual([
      ...agents.map((a) => ({ kind: "agent" as const, ...a })),
      { kind: "text", text: "2 tasks no agent ran on yet (see `task_tree`)." },
    ]);
  });

  test("no agent yet is one notice", () => {
    expect(readAgentList(formatAgentList([], 3))).toEqual([
      { kind: "text", text: "No agent has run on a task of this tree yet." },
    ]);
  });
});
