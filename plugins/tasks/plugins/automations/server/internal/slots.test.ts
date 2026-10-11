import { describe, expect, test } from "bun:test";
import { batchRemaining, freeSlots, selectLaunches } from "./slots";

const c = (taskId: string) => ({ taskId, variables: { title: taskId } });
const all = (...ids: string[]) => new Set(ids);
const ids = (xs: { taskId: string }[]) => xs.map((x) => x.taskId);

describe("freeSlots", () => {
  test("is the concurrency minus what runs", () => {
    expect(freeSlots(2, 0)).toBe(2);
    expect(freeSlots(2, 1)).toBe(1);
    expect(freeSlots(2, 2)).toBe(0);
  });

  test("never goes below zero when the concurrency was lowered under what runs", () => {
    expect(freeSlots(1, 3)).toBe(0);
  });
});

describe("batchRemaining", () => {
  test("is the cap minus what this batch launched", () => {
    expect(batchRemaining(5, 0)).toBe(5);
    expect(batchRemaining(5, 4)).toBe(1);
    expect(batchRemaining(5, 5)).toBe(0);
  });

  test("never goes below zero when the cap was lowered under what launched", () => {
    expect(batchRemaining(2, 4)).toBe(0);
  });
});

describe("selectLaunches", () => {
  test("takes the first `free` approved candidates, in rank order", () => {
    expect(
      ids(
        selectLaunches(
          [c("a"), c("b"), c("c")],
          all("a", "b", "c"),
          new Set(),
          2,
        ),
      ),
    ).toEqual(["a", "b"]);
  });

  test("never launches a candidate nobody approved, whatever its rank", () => {
    expect(
      ids(selectLaunches([c("a"), c("b"), c("c")], all("c"), new Set(), 3)),
    ).toEqual(["c"]);
  });

  test("launches nothing when nothing is approved", () => {
    expect(selectLaunches([c("a"), c("b")], new Set(), new Set(), 2)).toEqual(
      [],
    );
  });

  test("an approval of a task that is not a candidate launches nothing", () => {
    expect(selectLaunches([c("a")], all("z"), new Set(), 1)).toEqual([]);
  });

  test("skips taken tasks and fills the slot with the next approved one", () => {
    expect(
      ids(
        selectLaunches(
          [c("a"), c("b"), c("c")],
          all("a", "b", "c"),
          all("a"),
          2,
        ),
      ),
    ).toEqual(["b", "c"]);
  });

  test("launches a repeated id once", () => {
    expect(
      ids(
        selectLaunches([c("a"), c("a"), c("b")], all("a", "b"), new Set(), 3),
      ),
    ).toEqual(["a", "b"]);
  });

  test("launches nothing without a free slot", () => {
    expect(selectLaunches([c("a")], all("a"), new Set(), 0)).toEqual([]);
  });

  test("keeps each candidate's own variables", () => {
    expect(
      selectLaunches([c("a")], all("a"), new Set(), 1)[0]?.variables,
    ).toEqual({
      title: "a",
    });
  });
});
