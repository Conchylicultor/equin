import { expect, test } from "bun:test";
import { parseIconAnswer } from "./parse-icon-answer";

test("Google Fonts spelling maps to the installed dash names", () => {
  const answer = parseIconAnswer("ICON: ramen_dining\nALT: restaurant");
  expect(answer.ok ? String(answer.icon) : null).toBe("ramen-dining");
});

test("an unknown ICON falls back to ALT", () => {
  const answer = parseIconAnswer("ICON: not_a_symbol\nALT: `museum`");
  expect(answer.ok ? String(answer.icon) : null).toBe("museum");
});

test("an answer with no installed name is rejected", () => {
  expect(parseIconAnswer("I think a cafe icon would work").ok).toBe(false);
});
