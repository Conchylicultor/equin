import { describe, expect, test } from "bun:test";
import { checkAfterIds } from "./after-ids";

const known = new Set(["A", "B"]);
const exists = async (id: string) => known.has(id);

describe("checkAfterIds", () => {
  test("trims and deduplicates, keeping order", async () => {
    expect(await checkAfterIds([" B", "A", "B "], { exists })).toEqual({
      ok: true,
      after: ["B", "A"],
    });
  });

  test("refuses an empty list, the task itself, and an unknown task", async () => {
    expect(await checkAfterIds([], { exists })).toMatchObject({ ok: false });
    expect(await checkAfterIds([" "], { exists })).toMatchObject({
      ok: false,
    });
    expect(await checkAfterIds(["A"], { self: "A", exists })).toMatchObject({
      ok: false,
      message: "A task cannot run after itself.",
    });
    expect(await checkAfterIds(["A", "Z"], { exists })).toMatchObject({
      ok: false,
      message: '`after` task "Z" not found',
    });
  });
});
