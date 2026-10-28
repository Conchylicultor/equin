import { describe, expect, it } from "bun:test";
import { ANSWER_MARKER } from "../../shared";
import {
  parseMarkerAnswer,
  serializeMarkerAnswer,
  type Question,
} from "./answer-model";

function q(partial: Partial<Question> & { header: string }): Question {
  return {
    question: partial.question ?? `${partial.header}?`,
    header: partial.header,
    options: partial.options ?? [],
    multiSelect: partial.multiSelect ?? false,
  };
}

describe("parseMarkerAnswer", () => {
  it("parses headers that contain ': ' without mis-splitting the value", () => {
    const questions = [
      q({ header: "Scope: CLI fix", question: "Fix the CLI trigger?" }),
      q({ header: "Scope: kill hardening", question: "Harden the kill path?" }),
    ];
    const text = `${ANSWER_MARKER}\n\n- Scope: CLI fix: Both (Recommended)\n- Scope: kill hardening: Include (Recommended)`;

    const { answers } = parseMarkerAnswer(text, questions);

    expect(answers["Fix the CLI trigger?"]?.answer).toBe("Both (Recommended)");
    expect(answers["Harden the kill path?"]?.answer).toBe(
      "Include (Recommended)",
    );
  });

  it("parses simple single-colon headers", () => {
    const questions = [q({ header: "Library", question: "Which library?" })];
    const text = `${ANSWER_MARKER}\n\n- Library: date-fns`;

    const { answers } = parseMarkerAnswer(text, questions);

    expect(answers["Which library?"]?.answer).toBe("date-fns");
  });

  it("treats an empty value (e.g. multi-select with no choices) as null", () => {
    const questions = [q({ header: "Features", multiSelect: true })];
    const text = `${ANSWER_MARKER}\n\n- Features: `;

    const { answers } = parseMarkerAnswer(text, questions);

    expect(answers["Features?"]?.answer).toBeNull();
  });

  it("distinguishes two questions sharing the same header by position", () => {
    const questions = [
      q({ header: "Scope", question: "Q1" }),
      q({ header: "Scope", question: "Q2" }),
    ];
    const text = `${ANSWER_MARKER}\n\n- Scope: first\n- Scope: second`;

    const { answers } = parseMarkerAnswer(text, questions);

    expect(answers["Q1"]?.answer).toBe("first");
    expect(answers["Q2"]?.answer).toBe("second");
  });
});

describe("serializeMarkerAnswer", () => {
  const questions: Question[] = [
    {
      question: "Which scope?",
      header: "Scope: CLI fix",
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
      ],
      multiSelect: false,
    },
    {
      question: "Which extras?",
      header: "Extras",
      options: [
        { label: "X", description: "" },
        { label: "Y", description: "" },
      ],
      multiSelect: true,
    },
  ];

  it("writes the marker turn parseMarkerAnswer reads back", () => {
    const text = serializeMarkerAnswer(questions, {
      selections: {
        "Which scope?": { selected: ["B"], other: null },
        "Which extras?": { selected: ["X", "Y"], other: "Z" },
      },
      response: null,
    });
    expect(text).toBe(
      `${ANSWER_MARKER}\n\n- Scope: CLI fix: B\n- Extras: X, Y, Z`,
    );
    expect(parseMarkerAnswer(text, questions)).toEqual({
      answers: {
        "Which scope?": { answer: "B", notes: null },
        "Which extras?": { answer: "X, Y, Z", notes: null },
      },
      reply: null,
    });
  });

  it("appends a free-text reply after the lines, read back as the reply", () => {
    const text = serializeMarkerAnswer(questions, {
      selections: { "Which extras?": { selected: ["X"], other: null } },
      response: "- Scope: none of these\nlet's discuss first",
    });
    expect(text).toBe(
      `${ANSWER_MARKER}\n\n- Scope: CLI fix: \n- Extras: X\n\n- Scope: none of these\nlet's discuss first`,
    );
    expect(parseMarkerAnswer(text, questions)).toEqual({
      answers: {
        "Which scope?": { answer: null, notes: null },
        "Which extras?": { answer: "X", notes: null },
      },
      reply: "- Scope: none of these\nlet's discuss first",
    });
  });

  it("reads back a reply of several paragraphs beside full answers", () => {
    const text = serializeMarkerAnswer(questions, {
      selections: {
        "Which scope?": { selected: ["A"], other: null },
        "Which extras?": { selected: ["Y"], other: null },
      },
      response: "Rebase first.\n\nUse as many agents as necessary",
    });
    expect(parseMarkerAnswer(text, questions)).toEqual({
      answers: {
        "Which scope?": { answer: "A", notes: null },
        "Which extras?": { answer: "Y", notes: null },
      },
      reply: "Rebase first.\n\nUse as many agents as necessary",
    });
  });
});
