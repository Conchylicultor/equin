import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { maskedSource, parsedTsSource, sliceCheckThread } from "./source-work";

describe("source-work", () => {
  test("masks once per text, and recomputes when the text changes", async () => {
    const a = { rel: "a.ts", src: 'const x = "y"; // note' };
    const first = await maskedSource(a);
    expect(first).not.toContain("note");
    expect(first).not.toContain("y");
    expect(await maskedSource({ ...a })).toBe(first);
    // strings kept is its own entry
    expect(await maskedSource(a, { strings: false })).toContain('"y"');
    const changed = await maskedSource({ rel: "a.ts", src: "const z = 1;" });
    expect(changed).toBe("const z = 1;");
  });

  test("parses once per text: the same tree for the same bytes, a new one for new bytes", async () => {
    const src = { rel: "b.tsx", src: "export const a = <div />;" };
    const sf = await parsedTsSource(ts, src);
    expect(sf.statements.length).toBe(1);
    expect(await parsedTsSource(ts, { ...src })).toBe(sf);
    expect(
      await parsedTsSource(ts, { rel: "b.tsx", src: "export const b = 1;" }),
    ).not.toBe(sf);
  });

  test("a loop of slices lets a due timer run", async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    const until = performance.now() + 60;
    while (performance.now() < until) await sliceCheckThread();
    expect(fired).toBe(true);
  });
});
