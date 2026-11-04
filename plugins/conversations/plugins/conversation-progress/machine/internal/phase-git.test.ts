import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedAmong,
  mergeBase,
  phaseOfFiles,
  wholeTreePhase,
} from "./phase-git";

let dir: string;
let repo: string;

function git(...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
  return res.stdout.toString().trim();
}

function write(rel: string, text: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "progress-phase-test-")));
  repo = join(dir, "repo");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  write(".gitignore", "dist/\n");
  write("src/a.ts", "a");
  write("src/*.ts", "a file literally named *.ts");
  write("research/plan.md", "plan");
  git("add", ".");
  git("commit", "-q", "-m", "root");
  git("checkout", "-q", "-b", "work");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("phaseOfFiles", () => {
  test("no file is research, only research/** is design, anything else is implementation", () => {
    expect(phaseOfFiles([])).toBe("research");
    expect(phaseOfFiles(["research/x.md"])).toBe("design");
    expect(phaseOfFiles(["research/x.md", "src/a.ts"])).toBe("implementation");
  });
});

describe("changedAmong", () => {
  test("answers only for the paths it is given, against the base", async () => {
    const base = (await mergeBase(repo))!;
    expect(await wholeTreePhase(repo)).toBe("research");
    // Written with the same content: an event, but no change.
    write("src/a.ts", "a");
    expect(await changedAmong(repo, base, ["src/a.ts"])).toEqual([]);

    write("research/plan.md", "plan v2");
    write("src/new.ts", "untracked");
    write("dist/out.js", "ignored");
    // A path not asked about is not reported, changed or not.
    expect(await changedAmong(repo, base, ["research/plan.md"])).toEqual([
      "research/plan.md",
    ]);
    expect(
      (
        await changedAmong(repo, base, [
          "src/new.ts",
          "dist/out.js",
          "src/a.ts",
        ])
      ).sort(),
    ).toEqual(["src/new.ts"]);
    expect(await wholeTreePhase(repo)).toBe("implementation");
  });

  test("a path is literal, never a glob over the tree", async () => {
    const base = (await mergeBase(repo))!;
    write("src/a.ts", "changed");
    expect(await changedAmong(repo, base, ["src/*.ts"])).toEqual([]);
    write("src/a.ts", "a");
  });

  test("a directory with no git has no base", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await mergeBase(plain)).toBeNull();
  });
});
