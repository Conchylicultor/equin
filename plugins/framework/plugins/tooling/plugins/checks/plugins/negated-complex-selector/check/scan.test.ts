import { describe, expect, test } from "bun:test";
import { arbitraryVariants, complexNegations, hasCombinator } from "./scan";

const found = (src: string, underscoreIsSpace = false) =>
  complexNegations(src, { underscoreIsSpace }).map((n) => n.text);

describe("hasCombinator", () => {
  test("a compound or a list of compounds has none", () => {
    expect(hasCombinator(".a")).toBe(false);
    expect(hasCombinator(".a.b[data-x='y z']")).toBe(false);
    expect(hasCombinator("[data-a], [data-b]")).toBe(false);
    expect(hasCombinator(" .a , .b ")).toBe(false);
    expect(hasCombinator(":nth-child(1 of .a .b)")).toBe(false);
    expect(hasCombinator(".a:has(> .b)")).toBe(false);
  });
  test("every combinator counts, through :is / :where", () => {
    expect(hasCombinator(".a *")).toBe(true);
    expect(hasCombinator(".a>.b")).toBe(true);
    expect(hasCombinator(".a + .b")).toBe(true);
    expect(hasCombinator(".a ~ .b")).toBe(true);
    expect(hasCombinator(':where([data-input-modality="pointer"] *)')).toBe(
      true,
    );
    expect(hasCombinator(".x, :is(.a .b)")).toBe(true);
  });
});

describe("complexNegations", () => {
  test("flags the negated-ancestor shape", () => {
    expect(
      found('&:focus-visible:not(:where([data-input-modality="pointer"] *)) {'),
    ).toEqual([':not(:where([data-input-modality="pointer"] *))']);
    expect(found(".bar:not(.floating-bar-boundary *)")).toEqual([
      ":not(.floating-bar-boundary *)",
    ]);
  });
  test("an escaped paren does not end the argument", () => {
    expect(found(".a:not(.w-\\(1\\) *)")).toEqual([":not(.w-\\(1\\) *)"]);
  });
  test("passes the positive ancestor form and simple negations", () => {
    expect(
      found(
        ':where(:root:not([data-input-modality="pointer"])) .focus-ring:focus-visible',
      ),
    ).toEqual([]);
    expect(
      found(
        ":where([data-scroll-x-path] > :not([data-scroll-x-path], [data-scrolls-x]))",
      ),
    ).toEqual([]);
  });
  test("reads Tailwind's underscore as a space", () => {
    expect(found("[&:not(.boundary_*)]:p-2", true)).toEqual([
      ":not(.boundary_*)",
    ]);
    expect(found("[&_svg:not([class*='size-'])]:icon-auto", true)).toEqual([]);
    expect(
      found(
        "[&>:not(:nth-child(1_of_:is([data-seg],.contents:has(>[data-seg]))))]:-ml-px",
        true,
      ),
    ).toEqual([]);
  });
});

describe("arbitraryVariants", () => {
  test("finds each `[&…]:` variant in a class string", () => {
    const src = `cn("p-2 [&:not(.boundary_*)]:hidden [&_svg:not([class*='size-'])]:icon-auto", x)`;
    expect(arbitraryVariants(src).map((v) => v.text)).toEqual([
      "[&:not(.boundary_*)]:",
      "[&_svg:not([class*='size-'])]:",
    ]);
  });
  test("balances brackets, and reads every variant form", () => {
    const flagged = (src: string) =>
      arbitraryVariants(src).flatMap((v) =>
        complexNegations(v.text, { underscoreIsSpace: true }).map(
          (n) => n.text,
        ),
      );
    expect(flagged("[&:not([data-state=open]:hover_*)]:p-2")).toEqual([
      ":not([data-state=open]:hover_*)",
    ]);
    expect(flagged("group-[:not(.x_*)]:p-2")).toEqual([":not(.x_*)"]);
    expect(flagged("not-[.x_*]:p-2")).toEqual([":not(.x_*)"]);
    expect(flagged("[&:not(.x_*)]:[&_a]:p-2")).toEqual([":not(.x_*)"]);
    expect(flagged("not-[.x]:p-2 [&:not(.a,.b)]:p-2")).toEqual([]);
  });
  test("ignores a selector string that is not a variant", () => {
    expect(arbitraryVariants(`el.querySelector("a:not(button *)")`)).toEqual(
      [],
    );
  });
});
