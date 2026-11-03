import { expect, test } from "bun:test";
import { formatIfFormattable, formatSource, isFormattable } from "./prettier";

const UNFORMATTED = "const  x=1\n";
const FORMATTED = "const x = 1;\n";

test("formats an allowlisted source file", async () => {
  expect(await formatSource({ file: "a.ts", content: UNFORMATTED })).toBe(
    FORMATTED,
  );
});

test("formatting is idempotent on its own output", async () => {
  const once = await formatSource({ file: "a.tsx", content: UNFORMATTED });
  expect(await formatSource({ file: "a.tsx", content: once })).toBe(once);
});

// Non-formattable is a THROW, not the input echoed back. The two conditions
// "this type is held out" and "the caller handed me garbage" must not share a
// return value — that is what made the argument swap silent.
test.each([
  ["README.md", "a markdown doc"],
  ["x.origin.jsonc", "a config origin"],
  ["app.css", "a stylesheet"],
  ["web.generated.ts", "a generated artifact"],
])("formatSource throws for %s (%s)", async (file) => {
  expect(isFormattable(file)).toBe(false);
  const rejected = formatSource({ file, content: UNFORMATTED });
  expect(rejected).rejects.toThrow(/not a formattable path/);
});

// The 2026-08-17 incident, verbatim: an ad-hoc script called
// `formatSource(source, file)`, got the PATH back as "formatted source", wrote
// it, and destroyed 44 files with no error of any kind.
test("a swapped call throws and names the swap", async () => {
  const source = "import { join } from 'path'\nconst x=1\n";
  const rejected = formatSource({ file: source, content: "a.ts" });
  expect(rejected).rejects.toThrow(
    /Arguments swapped\? The shape is \{ file, content \}/,
  );
});

test("an empty file argument throws", async () => {
  const rejected = formatSource({ file: "", content: UNFORMATTED });
  expect(rejected).rejects.toThrow(/"file" is empty/);
});

test("a file argument longer than any path throws", async () => {
  const rejected = formatSource({
    file: "a".repeat(4097),
    content: UNFORMATTED,
  });
  expect(rejected).rejects.toThrow(/longer than any path/);
});

test.each(["README.md", "x.origin.jsonc", "app.css", "web.generated.ts"])(
  "formatIfFormattable returns %s byte-identical",
  async (file) => {
    expect(await formatIfFormattable({ file, content: UNFORMATTED })).toBe(
      UNFORMATTED,
    );
  },
);

test("formatIfFormattable still formats an allowlisted path", async () => {
  expect(
    await formatIfFormattable({ file: "a.mts", content: UNFORMATTED }),
  ).toBe(FORMATTED);
});

// The permissive arm is where a swapped call used to land silently, so it
// carries the same path assertion rather than trusting its caller.
test("formatIfFormattable rejects a non-path file argument", async () => {
  const rejected = formatIfFormattable({
    file: "const x=1\n",
    content: "a.ts",
  });
  expect(rejected).rejects.toThrow(/Arguments swapped\?/);
});
