import { describe, expect, test } from "bun:test";
import {
  ClassificationParseError,
  parseClassification,
} from "./parse-classification";

describe("parseClassification", () => {
  test("parses a bare JSON object", () => {
    expect(parseClassification('{"priority":"P0","app":"sonata"}')).toEqual({
      priority: "P0",
      app: "sonata",
    });
  });

  test("carves the object out of a code fence and surrounding prose", () => {
    const raw =
      'Sure! Here you go:\n```json\n{"priority": "P1"}\n```\nHope that helps.';
    expect(parseClassification(raw)).toEqual({ priority: "P1" });
  });

  test("a brace inside a string value does not end the object", () => {
    expect(parseClassification('{"app":"the {weird} one"}')).toEqual({
      app: "the {weird} one",
    });
  });

  test("an empty object is a legitimate answer — nothing applied", () => {
    expect(parseClassification("{}")).toEqual({});
  });

  test("no object at all throws rather than reading as empty", () => {
    expect(() => parseClassification("I could not decide.")).toThrow(
      ClassificationParseError,
    );
  });

  test("malformed JSON throws", () => {
    expect(() => parseClassification('{"priority": }')).toThrow(
      ClassificationParseError,
    );
  });

  test("non-string values throw", () => {
    expect(() => parseClassification('{"priority": ["P0"]}')).toThrow(
      ClassificationParseError,
    );
  });
});
