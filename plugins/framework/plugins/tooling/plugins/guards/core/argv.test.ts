import { describe, expect, test } from "bun:test";
import { parseArgv, redirectionTargets } from "./argv";
import type { FileOperand } from "./argv";
import { parseShell } from "./parse-shell";

// A deliberately fake repo root (not under /Users — see paths:no-hardcoded-paths).
const REPO = "/r/repo";
const WT = `${REPO}/.claude/worktrees/att-123-abcd`;

/** Parse through the real tokenizer, so quoting is exercised end to end. */
const argv = (cmd: string, cwd: string = WT) =>
  parseArgv(parseShell(cmd, cwd).calls[0]!);
const files = (cmd: string, cwd: string = WT) =>
  argv(cmd, cwd).files.map((f) => f.raw);
const localPaths = (operands: readonly FileOperand[]) =>
  operands.flatMap((o) => (o.kind === "local" ? [o.path] : []));
const paths = (cmd: string, cwd: string = WT) =>
  localPaths(argv(cmd, cwd).files);

describe("parseArgv", () => {
  describe("operands vs flags", () => {
    test("plain operands survive a flag cluster", () => {
      expect(files("rm -rf a b")).toEqual(["a", "b"]);
    });

    test("`--` ends options, so a dash-leading operand is a file", () => {
      expect(files("rm -- -weird")).toEqual(["-weird"]);
    });

    test("an empty operand names nothing (resolve(cwd, '') would have meant the cwd)", () => {
      expect(files("rm -- ''")).toEqual([]);
    });

    test("a bare `-` is a stream, not a file", () => {
      expect(files("rm -")).toEqual([]);
    });

    test("`--` mid-argv keeps the operands on both sides", () => {
      expect(files("rm a -- -b")).toEqual(["a", "-b"]);
    });
  });

  describe("consumed values are not files", () => {
    test("touch -r <reference>", () => {
      expect(files("touch -r ref f")).toEqual(["f"]);
    });

    test("touch -t <timestamp>", () => {
      expect(files("touch -t 202401010000 f")).toEqual(["f"]);
    });

    test("mkdir -m <mode>", () => {
      expect(files("mkdir -m 755 d")).toEqual(["d"]);
    });

    test("truncate -s <size>", () => {
      expect(files("truncate -s 0 f")).toEqual(["f"]);
    });

    test("shred -n <iterations>", () => {
      expect(files("shred -n 3 f")).toEqual(["f"]);
    });

    test("install -m <mode> keeps both operands", () => {
      expect(files("install -m 755 a b")).toEqual(["a", "b"]);
    });
  });

  describe("long options accept both spellings", () => {
    test("--reference=<file>", () => {
      expect(files("chmod --reference=r f")).toEqual(["f"]);
    });

    test("--reference <file> (separate token)", () => {
      expect(files("chmod --reference r f")).toEqual(["f"]);
    });

    test("--target-directory=<dir> is the destination, not an operand", () => {
      const a = argv("cp --target-directory=d a");
      expect(a.targetDir?.raw).toBe("d");
      expect(a.files.map((f) => f.raw)).toEqual(["a"]);
    });
  });

  describe("attached (optional-value) flags never eat the next token", () => {
    test("cp --backup keeps its source operand", () => {
      expect(files("cp --backup a b")).toEqual(["a", "b"]);
    });

    test("sed -i.bak glues its suffix", () => {
      expect(files("sed -i.bak 's/x/y/' f")).toEqual(["f"]);
    });

    test("rm --interactive=never", () => {
      expect(files("rm --interactive=never a")).toEqual(["a"]);
    });
  });

  describe("short-flag clusters", () => {
    test("a cluster of valueless letters leaves both operands", () => {
      expect(files("ln -sf a b")).toEqual(["a", "b"]);
    });

    test("an attached letter takes the cluster tail and ends the cluster", () => {
      const a = argv("sed -ie 's/a/b/' f");
      expect(a.files.map((f) => f.raw)).toEqual(["f"]);
      expect(a.flags.has("i")).toBe(true);
    });

    test("a letter consumed as another flag's value is NOT a flag", () => {
      // `-ei` is `-e` with the expression "i" — sed is not editing in place.
      expect(argv("sed -ei 'x' f").flags.has("i")).toBe(false);
    });

    test("perl -pi is in-place (the old startsWith('-i') probe missed it)", () => {
      const a = argv("perl -pi -e 's/a/b/' f");
      expect(a.files.map((f) => f.raw)).toEqual(["f"]);
      expect(a.flags.has("i")).toBe(true);
    });

    test("a consumed letter at the cluster end takes the next token", () => {
      expect(files("mkdir -pm 755 d")).toEqual(["d"]);
    });
  });

  describe("the leading operand is not a file", () => {
    test("BSD sed -i with a separate empty suffix", () => {
      expect(files("sed -i '' 's|a|b|' f")).toEqual(["f"]);
    });

    test("GNU sed -i with no suffix at all", () => {
      expect(files("sed -i 's|a|b|' f")).toEqual(["f"]);
    });

    test("sed -e supplies the script, so the next positional is a file", () => {
      expect(files("sed -i -e 's|a|b|' f")).toEqual(["f"]);
    });

    test("sed -f supplies the script file", () => {
      expect(files("sed -i -f p.sed f")).toEqual(["f"]);
    });

    test("awk spends its first positional on the program text", () => {
      expect(files("awk '{print}' f")).toEqual(["f"]);
    });

    test("awk -f supplies the program", () => {
      expect(files("awk -f p.awk f")).toEqual(["f"]);
    });

    test("awk -F takes its separator from the cluster tail", () => {
      expect(files("awk -F, '{print $1}' f")).toEqual(["f"]);
    });

    test("chmod's octal mode", () => {
      expect(files("chmod 755 f")).toEqual(["f"]);
    });

    test("chmod's symbolic mode", () => {
      expect(files("chmod +x f")).toEqual(["f"]);
    });

    test("chmod's dash-leading symbolic mode is the mode, not a flag", () => {
      // Without the leadingPattern, `f` would fill the mode slot and the file
      // would leave the write set entirely — a new under-block.
      expect(files("chmod -w f")).toEqual(["f"]);
    });

    test("a real chmod flag still walks as a flag", () => {
      expect(files("chmod -R 755 d")).toEqual(["d"]);
    });

    test("chown's owner spec", () => {
      expect(files("chown u:g f")).toEqual(["f"]);
    });

    test("chown --reference supplies the owner, so the positional is a file", () => {
      expect(files("chown --reference=r f")).toEqual(["f"]);
    });
  });

  describe("the reported case: a sed script is not a path", () => {
    test("substitution text with `..` sequences stays out of files", () => {
      const cmd = `sed -i '' 's|resolve(HERE, "../../../..");|const REPO_ROOT = resolve(HERE, "..");|' cli/equin-cli.ts`;
      expect(files(cmd)).toEqual(["cli/equin-cli.ts"]);
      expect(paths(cmd)).toEqual([`${WT}/cli/equin-cli.ts`]);
    });
  });

  describe("git", () => {
    test("the subcommand fills the leading slot", () => {
      expect(argv("git commit -m x").leading).toBe("commit");
    });

    test("-C is the directory, and the subcommand follows it", () => {
      const a = argv("git -C d status");
      expect(a.leading).toBe("status");
      expect(a.targetDir?.raw).toBe("d");
    });

    test("a preceding -c does not hide the -C (args[0] === '-C' saw only -c)", () => {
      const a = argv("git -c u=v -C d commit -m y");
      expect(a.leading).toBe("commit");
      expect(a.targetDir?.raw).toBe("d");
    });

    test("an unmodelled long flag takes no value", () => {
      expect(argv("git --no-pager log").leading).toBe("log");
    });

    test("--git-dir names the repository the subcommand changes", () => {
      const a = argv(`git --git-dir=${REPO}/.git commit -m x`);
      expect(a.leading).toBe("commit");
      expect(a.targetDir?.raw).toBe(`${REPO}/.git`);
    });

    test("--work-tree does too, in the separate-token spelling", () => {
      const a = argv(`git --work-tree ${REPO} checkout .`);
      expect(a.leading).toBe("checkout");
      expect(a.targetDir?.raw).toBe(REPO);
    });
  });

  describe("rsync remote specs", () => {
    test("a remote destination writes nothing locally", () => {
      const a = argv("rsync -a src/ h:/p");
      expect(a.files.map((f) => f.kind)).toEqual(["local", "remote"]);
      expect(a.files.map((f) => f.raw)).toEqual(["src/", "h:/p"]);
    });

    test("a remote SOURCE keeps its position, so the destination is still last", () => {
      const a = argv("rsync -a u@h:/p ./dst");
      expect(a.files.map((f) => f.kind)).toEqual(["remote", "local"]);
    });

    test("a colon after the first slash is a local path", () => {
      const a = argv("rsync -a ./x:y d/");
      expect(a.files.map((f) => f.kind)).toEqual(["local", "local"]);
    });

    test("a trailing value flag does not steal the destination slot", () => {
      expect(files("rsync -a s/ d/ --exclude foo")).toEqual(["s/", "d/"]);
    });
  });

  describe("resolution against the call's cwd", () => {
    test("a relative operand folds onto the call cwd", () => {
      expect(paths("rm a.ts")).toEqual([`${WT}/a.ts`]);
    });

    test("a leading `cd` moves the call cwd", () => {
      const call = parseShell("cd sub && touch x", WT).calls[1]!;
      expect(localPaths(parseArgv(call).files)).toEqual([`${WT}/sub/x`]);
    });

    test("an absolute operand passes through", () => {
      expect(paths(`rm ${REPO}/x.ts`)).toEqual([`${REPO}/x.ts`]);
    });

    test("no empty path ever appears", () => {
      expect(paths("rm -- '' a")).toEqual([`${WT}/a`]);
    });
  });

  describe("totality", () => {
    test("an unknown command falls back to the default grammar", () => {
      expect(files("frobnicate -x a b")).toEqual(["a", "b"]);
    });

    test("no args at all", () => {
      const a = argv("rm");
      expect(a.files).toEqual([]);
      expect([...a.flags]).toEqual([]);
      expect(a.leading).toBeUndefined();
    });

    test("a flag whose value is missing does not throw", () => {
      expect(() => argv("sed -e")).not.toThrow();
      expect(() => argv("cp -t")).not.toThrow();
      expect(() => argv("chmod")).not.toThrow();
    });
  });

  describe("redirectionTargets", () => {
    test("resolves against the writing call's cwd", () => {
      const call = parseShell("cd sub && echo x > out.txt", WT).calls[1]!;
      expect(localPaths(redirectionTargets(call))).toEqual([
        `${WT}/sub/out.txt`,
      ]);
    });
  });
});
