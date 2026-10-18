import { describe, expect, test } from "bun:test";
import {
  classifyGitStatus,
  isSafeToReap,
  isTaskDeletable,
  needsHygiene,
  SAFE_REAP_AGE_MS,
  type SafetyInput,
} from "./safety";
import { AUTO_REAP_AGE_MS } from "./reap-policy";

// A realistic `git status --porcelain=v2 --branch` header for a clean branch
// that has an upstream and is level with it.
const CLEAN_HEADER = [
  "# branch.oid 73be6f4e9860a9801bfdc60ff93c50093c812f08",
  "# branch.head claude-web/att-1786116592-q1dq",
  "# branch.upstream origin/claude-web/att-1786116592-q1dq",
  "# branch.ab +0 -0",
  "",
].join("\n");

describe("classifyGitStatus", () => {
  test("a clean tree reads clean", () => {
    expect(classifyGitStatus(CLEAN_HEADER)).toEqual({ isDirty: false });
  });

  test("a modified file reads dirty", () => {
    const out =
      CLEAN_HEADER + "1 .M N... 100644 100644 100644 abc def plugins/foo.ts\n";
    expect(classifyGitStatus(out)).toEqual({ isDirty: true });
  });

  test("an untracked file reads dirty", () => {
    expect(classifyGitStatus(CLEAN_HEADER + "? notes.md\n")).toEqual({
      isDirty: true,
    });
  });

  // Commits are not hygiene: the reap leaves the branch ref in the main repo,
  // so a branch with no upstream (most of them — push merges into local main)
  // or ahead of it has nothing that exists only in the checkout.
  test("a clean branch with NO upstream reads clean and is reapable", () => {
    const noUpstream = [
      "# branch.oid 73be6f4e9860a9801bfdc60ff93c50093c812f08",
      "# branch.head claude-web/att-1786116592-q1dq",
      "",
    ].join("\n");
    const hygiene = classifyGitStatus(noUpstream);
    expect(hygiene).toEqual({ isDirty: false });
    expect(isSafeToReap(input({ ...hygiene }))).toBe(true);
  });

  test("commits ahead of upstream do not read dirty", () => {
    const out = CLEAN_HEADER.replace("# branch.ab +0 -0", "# branch.ab +2 -0");
    expect(classifyGitStatus(out)).toEqual({ isDirty: false });
  });

  // Bun.spawn does not throw on a nonzero exit, so a failed `git status`
  // reached the parser as an empty string and — having no non-`#` lines — read
  // as clean, the maximally reapable answer.
  test("empty output (failed git) is conservative, not clean", () => {
    expect(classifyGitStatus("")).toEqual({ isDirty: true });
  });

  test("unparseable output is conservative", () => {
    expect(classifyGitStatus("fatal: not a git repository\n")).toEqual({
      isDirty: true,
    });
  });
});

// A fully reapable attempt: dir present, clean, task finished, old
// enough, and the user has closed every conversation on it.
function input(over: Partial<SafetyInput> = {}): SafetyInput {
  return {
    dirExists: true,
    dbPresent: true,
    isDirty: false,
    taskDeletable: true,
    ageMs: SAFE_REAP_AGE_MS,
    retained: false,
    ...over,
  };
}

describe("isSafeToReap", () => {
  test("the fully-finished baseline is reapable", () => {
    expect(isSafeToReap(input())).toBe(true);
  });

  // THE regression this guard exists for. A conversation whose pane was killed to
  // reclaim resources is dormant, not finished — `gone` is the status
  // resumeConversation requires — so its worktree must survive every branch.
  test("a retained attempt is never reapable, however old and clean", () => {
    expect(isSafeToReap(input({ retained: true }))).toBe(false);
    expect(
      isSafeToReap(input({ retained: true, ageMs: 365 * 24 * 60 * 60 * 1000 })),
    ).toBe(false);
  });

  // The orphan branch is age-free and used to short-circuit before any intent
  // check. For the 21 half-deleted attempts this bug produced, the fork DB is the
  // only surviving copy of their state, so dropping it would finish the job.
  test("retention outranks the orphan short-circuit", () => {
    const orphan = input({ dirExists: false, dbPresent: true });
    expect(isSafeToReap(orphan)).toBe(true);
    expect(isSafeToReap({ ...orphan, retained: true })).toBe(false);
  });

  test("a dirty tree blocks reaping", () => {
    expect(isSafeToReap(input({ isDirty: true }))).toBe(false);
  });

  test("an unfinished task blocks reaping", () => {
    expect(isSafeToReap(input({ taskDeletable: false }))).toBe(false);
  });

  test("a worktree younger than the floor is not reapable", () => {
    expect(isSafeToReap(input({ ageMs: SAFE_REAP_AGE_MS - 1 }))).toBe(false);
  });

  test("a vanished dir with no DB is nothing to reclaim", () => {
    expect(isSafeToReap(input({ dirExists: false, dbPresent: false }))).toBe(
      false,
    );
  });
});

// The guard on the reaper's "skip the git probe" short-circuit. `needsHygiene`
// claims that outside its window the subprocess answer is ignored — this pins
// that claim to `isSafeToReap` itself, so a future term that reads hygiene
// somewhere new fails here instead of silently making the reaper trust a
// conservative default it never obtained.
//
// The invariant is stated over the reaper's FULL verdict, `isSafeToReap(...) ||
// hardFloor`, not over `isSafeToReap` alone: past the 90-day floor the reaper
// takes a dirty worktree, so `isSafeToReap` itself legitimately differs between
// clean and dirty there while the verdict does not. Below the floor the two
// statements coincide, and the second assertion pins that stronger form.
describe("needsHygiene short-circuit", () => {
  const CLEAN = { isDirty: false };
  const DIRTY = { isDirty: true };

  const AGES = [
    0,
    SAFE_REAP_AGE_MS - 1,
    SAFE_REAP_AGE_MS,
    AUTO_REAP_AGE_MS - 1,
    AUTO_REAP_AGE_MS,
    AUTO_REAP_AGE_MS * 2,
  ];

  test("where no probe is needed, the git answer cannot move the verdict", () => {
    for (const dbPresent of [true, false]) {
      for (const taskDeletable of [true, false]) {
        for (const ageMs of AGES) {
          const hardFloor = ageMs >= AUTO_REAP_AGE_MS;
          if (needsHygiene({ hardFloor, taskDeletable, ageMs })) continue;

          const base = {
            dirExists: true,
            dbPresent,
            taskDeletable,
            ageMs,
            retained: false,
          };
          const verdict = (h: typeof CLEAN) =>
            isSafeToReap({ ...base, ...h }) || hardFloor;

          expect(verdict(CLEAN)).toBe(verdict(DIRTY));
          if (!hardFloor) {
            expect(isSafeToReap({ ...base, ...CLEAN })).toBe(
              isSafeToReap({ ...base, ...DIRTY }),
            );
          }
        }
      }
    }
  });

  test("a probe IS asked for where the verdict is exactly the git answer", () => {
    const ageMs = SAFE_REAP_AGE_MS;
    expect(needsHygiene({ hardFloor: false, taskDeletable: true, ageMs })).toBe(
      true,
    );
    const base = {
      dirExists: true,
      dbPresent: true,
      taskDeletable: true,
      ageMs,
      retained: false,
    };
    expect(isSafeToReap({ ...base, ...CLEAN })).toBe(true);
    expect(isSafeToReap({ ...base, ...DIRTY })).toBe(false);
  });
});

describe("isTaskDeletable", () => {
  test("done and dropped are finished", () => {
    expect(isTaskDeletable("done")).toBe(true);
    expect(isTaskDeletable("dropped")).toBe(true);
  });

  // Holding is the user parking work they mean to resume.
  test("held is not finished", () => {
    expect(isTaskDeletable("held")).toBe(false);
  });

  test("in-flight statuses are not finished", () => {
    expect(isTaskDeletable("in_progress")).toBe(false);
    expect(isTaskDeletable("new")).toBe(false);
  });
});
