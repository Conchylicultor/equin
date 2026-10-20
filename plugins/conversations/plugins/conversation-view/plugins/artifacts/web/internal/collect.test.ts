import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { ArtifactHit } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { collectArtifacts, type KindExtractor } from "./collect";

function toolCall(name: string, at: string, input: unknown): JsonlEvent {
  return { kind: "tool-call", at, toolUseId: `t-${at}`, name, input };
}

/** A kind that claims every tool call naming it, as a fixed relation. */
function kindOn(
  id: string,
  toolName: string,
  relation: ArtifactHit["relation"],
  origin: KindExtractor["origin"] = "produced",
): KindExtractor {
  return {
    id,
    origin,
    extract: (event) =>
      event.kind === "tool-call" && event.name === toolName
        ? [{ kind: id, key: String(event.input), relation, at: event.at }]
        : [],
  };
}

const EVENTS: JsonlEvent[] = [
  toolCall("Read", "2026-09-19T10:00:00Z", "a"),
  toolCall("Write", "2026-09-19T10:01:00Z", "a"),
  toolCall("Write", "2026-09-19T10:02:00Z", "b"),
];

describe("collectArtifacts", () => {
  test("no registered kinds settles at zero", () => {
    const result = collectArtifacts([], EVENTS);
    expect(result).toEqual({
      byKind: new Map(),
      total: 0,
      made: new Map(),
      count: 0,
    });
  });

  test("every kind sees every event, and the total spans all of them", () => {
    const result = collectArtifacts(
      [
        kindOn("read", "Read", "referenced"),
        kindOn("write", "Write", "created"),
      ],
      EVENTS,
    );
    expect(result.total).toBe(3);
    expect(result.byKind.get("read")?.map((i) => i.key)).toEqual(["a"]);
    expect(result.byKind.get("write")?.map((i) => i.key)).toEqual(["a", "b"]);
  });

  test("a consumed kind is listed but left out of the count", () => {
    const result = collectArtifacts(
      [
        kindOn("looked", "Read", "referenced", "consumed"),
        kindOn("made", "Write", "created"),
      ],
      EVENTS,
    );
    // Three artifacts in the panel, two of them the conversation's own work.
    expect(result.total).toBe(3);
    expect(result.count).toBe(2);
    expect([...result.made]).toEqual([["made", 2]]);
    expect(result.byKind.get("looked")?.map((i) => i.key)).toEqual(["a"]);
  });

  test("a conversation that only looked has something to list, nothing to count", () => {
    const result = collectArtifacts(
      [kindOn("looked", "Read", "referenced", "consumed")],
      EVENTS,
    );
    expect(result.total).toBe(1);
    expect(result.count).toBe(0);
  });

  test("a produced kind counts only what was created or edited, not read", () => {
    const result = collectArtifacts(
      [
        kindOn("read", "Read", "referenced"),
        kindOn("write", "Write", "created"),
      ],
      EVENTS,
    );
    // The read-only kind is listed, but draws nothing on the button.
    expect(result.byKind.get("read")?.length).toBe(1);
    expect(result.made.has("read")).toBe(false);
    expect(result.made.get("write")).toBe(2);
    expect(result.count).toBe(2);
  });

  test("an item read then written counts once, as made", () => {
    const docs: KindExtractor = {
      id: "doc",
      origin: "produced",
      extract: (event) =>
        event.kind === "tool-call"
          ? [
              {
                kind: "doc",
                key: String(event.input),
                relation: event.name === "Read" ? "referenced" : "created",
                at: event.at,
              },
            ]
          : [],
    };
    const result = collectArtifacts([docs], EVENTS);
    expect(result.made.get("doc")).toBe(2);
  });

  test("repeat sightings inside one kind collapse to one item", () => {
    const result = collectArtifacts(
      [kindOn("write", "Write", "created")],
      [...EVENTS, toolCall("Write", "2026-09-19T10:03:00Z", "a")],
    );
    expect(result.total).toBe(2);
    expect(result.byKind.get("write")?.[0]?.lastAt).toBe(
      "2026-09-19T10:03:00Z",
    );
  });

  test("a kind reporting under another kind's name fails loudly", () => {
    const liar: KindExtractor = {
      id: "mine",
      origin: "produced",
      extract: (event) => [
        { kind: "yours", key: "x", relation: "created", at: event.at },
      ],
    };
    expect(() => collectArtifacts([liar], EVENTS)).toThrow(
      /emitted a hit for kind "yours"/,
    );
  });
});
