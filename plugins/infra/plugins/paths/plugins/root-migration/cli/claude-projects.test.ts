import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDirName } from "@plugins/infra/plugins/paths/core";
import { moveClaudeProjects } from "./claude-projects";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

const OLD = "/home/u/.old";
const NEW = "/home/u/.equin";
const CWD = `${OLD}/state/workspaces/att-1`;

function projectsWith(firstLines: string[]): string {
  const projects = mkdtempSync(join(tmpdir(), "claude-projects-"));
  dirs.push(projects);
  const dir = join(projects, claudeProjectDirName(CWD));
  mkdirSync(dir);
  writeFileSync(join(dir, "s.jsonl"), firstLines.join("\n") + "\n");
  return projects;
}

test("renames a dir whose cwd sits on its first line", () => {
  const projects = projectsWith([JSON.stringify({ cwd: CWD })]);
  const [rename] = moveClaudeProjects(projects, [{ from: OLD, to: NEW }], true);
  const to = join(
    projects,
    claudeProjectDirName(`${NEW}/state/workspaces/att-1`),
  );
  expect(rename).toEqual({
    from: join(projects, claudeProjectDirName(CWD)),
    to,
    conflict: false,
  });
  expect(existsSync(to)).toBe(true);
});

test("finds the cwd past a first line longer than one read chunk", () => {
  // A triage session opens with its whole prompt on a `queue-operation` line
  // that carries no cwd; the first `cwd` comes after it.
  const projects = projectsWith([
    JSON.stringify({ type: "queue-operation", content: "x".repeat(200_000) }),
    JSON.stringify({ type: "user", cwd: CWD }),
  ]);
  const renames = moveClaudeProjects(projects, [{ from: OLD, to: NEW }], false);
  expect(renames.map((r) => r.to)).toEqual([
    join(projects, claudeProjectDirName(`${NEW}/state/workspaces/att-1`)),
  ]);
});
