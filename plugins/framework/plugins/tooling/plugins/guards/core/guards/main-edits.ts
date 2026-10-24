import { resolve } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { defineGuard } from "../define-guard";
import type { FileInput } from "../types";
import { worktreeContextOf } from "../worktree-root";

export const mainEditsGuard = defineGuard<FileInput>({
  name: "main-edits",
  matcher: ["Write", "Edit", "NotebookEdit"],
  bypassToken: ".allow-main",
  check(input, ctx) {
    let f = input.file_path;
    if (!f) return null;
    if (!f.startsWith("/")) f = resolve(ctx.cwd, f);

    // The allowed boundary is the workspace ROOT, not raw cwd — the hook cwd
    // tracks the shell's persistent `cd` and can sit in any subdirectory.
    const workRoot = ctx.workRoot;
    if (f === workRoot || f.startsWith(`${workRoot}/`)) return null;

    // `/tmp` is a symlink to `/private/tmp` on macOS, so the scratchpad the
    // harness hands agents surfaces as its resolved `/private/tmp/...` form.
    if (/^\/(private\/)?tmp\//.test(f)) return null;

    // Declared data dirs the entry point resolved for us — host-global user
    // content that lives outside every checkout on purpose. The `/` in the
    // prefix is load-bearing: without it a sibling named `<dir>-scratch` would
    // pass the same test, the same reason `resolvePrototypeFile` compares
    // against `root + sep`.
    const target = f;
    if (
      ctx.writableDataDirs.some(
        (d) => target === d || target.startsWith(`${d}/`),
      )
    ) {
      return null;
    }

    const projectsPrefix = `${HOME_DIR}/.claude/projects/`;
    if (f.startsWith(projectsPrefix)) {
      const rest = f.slice(projectsPrefix.length);
      // Persisted Workflow scripts the Workflow tool tells agents to edit in
      // place: ~/.claude/projects/<slug>/<session>/workflows/scripts/**
      if (rest.includes("/workflows/scripts/")) {
        return null;
      }
    }

    if (f.startsWith(`${HOME_DIR}/.claude/plans/`)) {
      return {
        blocked: `Do not edit plan files directly (${f}).`,
        hint: "Use the `plan` skill instead — it writes the plan doc to the correct location.",
        skipEpilogue: true,
      };
    }

    // Re-base a main-checkout path onto the worktree for the hint — but only
    // when f is genuinely in the main checkout. A path inside ANOTHER agent's
    // worktree must not be re-based (it would compose a nonsense path).
    const repoRoot = ctx.protectedRoot;
    const relPath =
      repoRoot &&
      worktreeContextOf(workRoot) !== null &&
      f.startsWith(`${repoRoot}/`) &&
      worktreeContextOf(f) === null
        ? f.slice(repoRoot.length)
        : null;

    // Built from the same values the checks above read, so the message can
    // never advertise an allowlist the guard does not actually apply.
    const allowlist = [
      `workspace ${workRoot}`,
      "/tmp",
      ...ctx.writableDataDirs,
    ].join(", ");

    return {
      blocked: `Refusing to edit ${f} — this path is not in the allowlist (${allowlist}).`,
      hint: relPath
        ? `Edit \`${workRoot}${relPath}\` instead — your worktree IS your working copy of the repo.`
        : worktreeContextOf(workRoot)
          ? `Your worktree IS your working copy of the repo — it contains everything the main repo does, including .claude/skills/ and .claude/settings.json. Edit those files at ${workRoot}/.claude/** instead of the shared root.`
          : `Write inside your workspace (${workRoot}) or /tmp instead.`,
    };
  },
});
