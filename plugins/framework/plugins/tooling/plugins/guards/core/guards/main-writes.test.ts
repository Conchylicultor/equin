import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { worktreeContextOf } from "../worktree-root";
import { mainWritesGuard } from "./main-writes";

// A deliberately fake repo root (not under /Users — see paths:no-hardcoded-paths).
const REPO = "/r/repo";
const WT = `${REPO}/.claude/worktrees/att-123-abcd`;

function verdict(command: string, cwd: string): Verdict {
  // Synchronous check; the fake cwd never holds a bypass token file.
  return mainWritesGuard.check({ command }, createContext(cwd)) as Verdict;
}
const blocks = (command: string, cwd: string) =>
  verdict(command, cwd).kind === "deny";

describe("main-writes guard", () => {
  describe("boundaries derive from the worktree marker, not raw cwd", () => {
    test("blocks a cp into the main checkout from the worktree root", () => {
      expect(blocks(`cp file.ts ${REPO}/plugins/file.ts`, WT)).toBe(true);
    });

    test("still blocks it when cwd is a worktree SUBDIRECTORY (old code mis-derived the repo root and let it through)", () => {
      expect(
        blocks(`cp file.ts ${REPO}/plugins/file.ts`, `${WT}/gateway`),
      ).toBe(true);
    });

    test("allows writes to a sibling dir of the agent's own worktree from a subdirectory cwd (old false positive)", () => {
      expect(blocks(`cp notes.md ../research/notes.md`, `${WT}/gateway`)).toBe(
        false,
      );
    });

    test("blocks a redirection into the main checkout from a subdirectory cwd", () => {
      expect(blocks(`echo x > ${REPO}/notes.txt`, `${WT}/gateway`)).toBe(true);
    });

    test("blocks git -C <main repo> mutations from inside the worktree", () => {
      expect(blocks(`git -C ${REPO} commit -m x`, `${WT}/gateway`)).toBe(true);
    });
  });

  // A file descriptor is not a path. Resolving the word after `>` as one blocked
  // every read-only command that merged stderr into stdout while the shell sat
  // in the main checkout — and the deny told the agent to stop and ask.
  describe("a redirection that names no file is not a write", () => {
    test("2>&1", () => {
      expect(blocks(`cd ${REPO} && git worktree list 2>&1`, WT)).toBe(false);
    });

    test("&>/dev/null", () => {
      expect(blocks(`cd ${REPO} && ls -la &>/dev/null`, WT)).toBe(false);
    });

    test(">&- closes a fd", () => {
      expect(blocks(`cd ${REPO} && ls >&-`, WT)).toBe(false);
    });

    test("a process substitution arg", () => {
      expect(blocks(`cd ${REPO} && tee >(cat)`, WT)).toBe(false);
    });

    test("an input redirection is not the destination of a cp", () => {
      // The destination is /tmp/b; `c` is what cp READS. Reading `c` as the last
      // positional made it the destination, and resolved it into main.
      expect(blocks(`cd ${REPO} && cp a /tmp/b < c`, WT)).toBe(false);
    });

    test("`[[ a > b ]]` compares strings", () => {
      expect(blocks(`cd ${REPO} && [[ "$a" > "$b" ]] && echo y`, WT)).toBe(
        false,
      );
    });
  });

  // The same broken grammar hid real writes. Each of these reached main unseen.
  describe("redirections into main that used to slip past", () => {
    test("a quoted target", () => {
      expect(blocks(`echo x > "${REPO}/notes.txt"`, WT)).toBe(true);
    });

    test(">| overriding noclobber", () => {
      expect(blocks(`echo x >| ${REPO}/notes.txt`, WT)).toBe(true);
    });

    test(">& to a path sends both streams there", () => {
      expect(blocks(`echo x >&${REPO}/notes.txt`, WT)).toBe(true);
    });

    test("&> to a path", () => {
      expect(blocks(`echo x &> ${REPO}/notes.txt`, WT)).toBe(true);
    });

    test("a command hidden inside a process substitution", () => {
      expect(blocks(`tee >(rm ${REPO}/x)`, WT)).toBe(true);
    });
  });

  describe("stays inert where it should", () => {
    test("non-worktree session (cwd in the main checkout)", () => {
      expect(blocks(`cp a.ts ${REPO}/plugins/a.ts`, REPO)).toBe(false);
    });

    test("writes outside the repo entirely", () => {
      expect(blocks(`cp a.ts /tmp/a.ts`, `${WT}/gateway`)).toBe(false);
    });

    test("writes within the worktree", () => {
      expect(blocks(`mkdir -p research && touch research/x.md`, WT)).toBe(
        false,
      );
    });
  });

  describe("parses operands, not path-shaped substrings", () => {
    test("a sed script whose text contains `..` sequences (the reported false positive)", () => {
      // `path.resolve` used to normalise the `..` inside the SCRIPT and land it
      // under the repo root; the file actually edited is in the worktree.
      const cmd = `sed -i '' 's|resolve(HERE, "../../../..");|const REPO_ROOT = resolve(HERE, "..");|' cli/singularity.ts`;
      expect(blocks(cmd, WT)).toBe(false);
    });

    test("touch -r reads its reference file, it does not write it", () => {
      expect(
        blocks(`touch -r ../../../plugins/a.ts research/x`, `${WT}/a/b`),
      ).toBe(false);
    });

    test("a chmod mode is not a path", () => {
      expect(blocks(`chmod 755 f`, WT)).toBe(false);
    });

    test("a mkdir mode is not a path", () => {
      expect(blocks(`mkdir -m 755 d`, WT)).toBe(false);
    });

    test("a truncate size is not a path", () => {
      expect(blocks(`truncate -s 0 f`, WT)).toBe(false);
    });

    test("an install mode is not a path", () => {
      expect(blocks(`install -m 755 a b`, WT)).toBe(false);
    });

    test("an rsync remote destination writes nothing on this machine", () => {
      expect(blocks(`rsync -a src/ user@host:/tmp/dst/`, WT)).toBe(false);
    });
  });

  describe("does not weaken", () => {
    test("BSD sed -i into the main checkout", () => {
      expect(blocks(`sed -i '' 's|a|b|' ${REPO}/x.ts`, WT)).toBe(true);
    });

    test("GNU sed -i into the main checkout", () => {
      expect(blocks(`sed -i 's|a|b|' ${REPO}/x.ts`, WT)).toBe(true);
    });
  });

  describe("closes the under-blocks the positional grammar had", () => {
    test("rm past a `--` terminator (the operand was filtered away as a flag)", () => {
      expect(blocks(`cd ${REPO} && rm -- -weird`, WT)).toBe(true);
    });

    test("perl -pi (the startsWith('-i') probe never saw the cluster)", () => {
      expect(blocks(`perl -pi -e 's/a/b/' ${REPO}/x.ts`, WT)).toBe(true);
    });

    test("sed --in-place (the long form was missed entirely)", () => {
      expect(blocks(`sed --in-place 's/a/b/' ${REPO}/x.ts`, WT)).toBe(true);
    });

    test("cp -t <dir> (the destination read as a flag, the last operand as a source)", () => {
      expect(blocks(`cp -t ${REPO} a.ts`, WT)).toBe(true);
    });

    test("rsync with a trailing value flag (it stole the last-operand slot)", () => {
      expect(blocks(`rsync -a src/ ${REPO}/dst/ --exclude foo`, WT)).toBe(true);
    });

    test("git -c before -C (the args[0] === '-C' probe saw only -c)", () => {
      expect(blocks(`git -c user.name=x -C ${REPO} commit -m y`, WT)).toBe(
        true,
      );
    });

    test("install -d (dest-last bailed out on a single operand)", () => {
      expect(blocks(`install -d ${REPO}/newdir`, WT)).toBe(true);
    });

    test("git --git-dir reaches the main repo without naming it as an operand", () => {
      expect(blocks(`git --git-dir=${REPO}/.git commit -m x`, WT)).toBe(true);
    });

    test("git --work-tree does the same in the separate-token spelling", () => {
      expect(blocks(`git --work-tree ${REPO} checkout .`, WT)).toBe(true);
    });
  });

  describe("documented residual gap", () => {
    test("BSD sed -i with a NON-EMPTY separate suffix over-blocks a worktree file", () => {
      // BSD spells the backup suffix as its own token (`-i .bak`), so `.bak`
      // fills the script slot and the script itself stays in the operand list.
      // A script carrying `..` sequences then resolves out of the worktree, and
      // the guard denies a command that only ever edits `local.ts`.
      //
      // We keep the over-block deliberately. The alternative is to let `-i`
      // reach for the next token, and that breaks GNU's spelling
      // (`sed -i 's/a/b/' f`) by eating the script — an UNDER-block on the far
      // more common form. Over-blocking is this guard's safe direction, and the
      // file it really edits is caught either way.
      expect(blocks(`sed -i .bak 's|../../../x|y|' local.ts`, WT)).toBe(true);
    });
  });
});

// An app-launched agent names its workspace (SINGULARITY_WORKSPACE_ROOT); in a
// scratch workspace — outside every checkout — the protected tree is the main
// checkout of the code the guards run from.
describe("main-writes guard in a launch-named workspace", () => {
  const MAIN = worktreeContextOf(REPO_ROOT)?.repoRoot ?? REPO_ROOT;
  const SCRATCH = "/s/state/workspaces/att-1-abcd";
  const launched = (command: string, cwd: string, root: string) =>
    (
      mainWritesGuard.check(
        { command },
        createContext(cwd, "s", [], undefined, null, null, root),
      ) as Verdict
    ).kind === "deny";

  test("a scratch agent cannot write into the main checkout", () => {
    expect(launched(`cp out.xml ${MAIN}/plugins/x.xml`, SCRATCH, SCRATCH)).toBe(
      true,
    );
    expect(
      launched(`echo x > ${MAIN}/notes.txt`, `${SCRATCH}/sub`, SCRATCH),
    ).toBe(true);
  });

  test("it writes freely inside its own workspace, from any subdirectory", () => {
    expect(launched("cp a.txt ../b.txt", `${SCRATCH}/sub`, SCRATCH)).toBe(
      false,
    );
  });

  test("a launched worktree agent keeps the worktree boundary", () => {
    expect(launched(`cp f.ts ${REPO}/plugins/f.ts`, `${WT}/gateway`, WT)).toBe(
      true,
    );
    expect(launched(`cp f.ts ${WT}/plugins/f.ts`, `${WT}/gateway`, WT)).toBe(
      false,
    );
  });
});
