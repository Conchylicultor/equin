import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOGO } from "../../core";

// Tailwind reads class names from source, so the master switch's breakpoint is
// a literal in logo.tsx; it must stay just under LOGO.smallBelowPx.
test("the <Logo> master switch is at LOGO.smallBelowPx", () => {
  const src = readFileSync(join(import.meta.dir, "logo.tsx"), "utf8");
  const at = `@max-[${LOGO.smallBelowPx - 0.01}px]`;
  expect(src.split(at).length - 1).toBe(2);
});
