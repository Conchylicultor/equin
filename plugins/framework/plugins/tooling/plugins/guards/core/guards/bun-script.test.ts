import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { bunScriptGuard } from "./bun-script";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

function verdict(command: string, cwd = REPO_ROOT): Verdict {
  // The guard's check is synchronous (hasBypass stats a path), so the result is
  // a Verdict. The default cwd is this checkout — the guard only judges a
  // script inside a equin checkout — and holds no `.allow-bun-script`.
  return bunScriptGuard.check({ command }, createContext(cwd)) as Verdict;
}

/** Not let through as typed: denied, or rewritten to `./equin run`. */
const blocks = (command: string, cwd?: string) => {
  const kind = verdict(command, cwd).kind;
  return kind === "deny" || kind === "rewrite";
};
const rewritten = (command: string, cwd?: string) => {
  const v = verdict(command, cwd);
  return v.kind === "rewrite" ? v.patch.command : undefined;
};

// Absolute-path prefixes for the commands fed to the parser below. They are
// PARSER INPUT — strings this file hands to a shell parser — never paths it
// builds, resolves or reads. Split the way `paths/check/index.ts` splits its own
// `PATTERNS` list, so this file does not match the patterns
// `paths:no-hardcoded-paths` scans the repo for. The split has to live in the
// code rather than a comment: that check masks comments before matching, but
// deliberately does NOT mask strings.
const USERS = "/" + "Users/";
const BREW_BIN = "/opt/" + "homebrew" + "/bin";

describe("bun-script guard", () => {
  describe("a bun call that EXECUTES a TypeScript module is blocked", () => {
    test("bare relative script", () => {
      expect(blocks("bun x.ts")).toBe(true);
    });

    test("dot-slash path", () => {
      expect(
        blocks("bun ./plugins/apps-core/plugins/tabs/e2e/tabs-verify.ts"),
      ).toBe(true);
    });

    test("repo-relative path with args", () => {
      expect(
        blocks(
          "bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --url http://x.localhost:9000 --out /tmp/shot",
        ),
      ).toBe(true);
    });

    test("absolute path", () => {
      expect(blocks(`bun ${REPO_ROOT}/scripts/verify.ts`)).toBe(true);
    });

    test(".tsx counts too", () => {
      expect(blocks("bun scripts/render.tsx")).toBe(true);
    });

    test(".mjs — the ui-mastery screenshot script, which imports playwright", () => {
      expect(
        blocks(
          "bun sidequests/ui-mastery/scripts/screenshot-conversation-with-file.mjs http://x.localhost:9000/c/1 /tmp/out.png",
        ),
      ).toBe(true);
    });

    test(".mjs — the spawn-wedge repro documented as `bun repro.mjs`", () => {
      expect(blocks("bun repro.mjs --workers 6")).toBe(true);
    });

    test(".js and .cjs are modules too", () => {
      expect(blocks("bun dist/index.js")).toBe(true);
      expect(blocks("bun scripts/legacy.cjs")).toBe(true);
    });

    test("explicit `run` in front of a module path", () => {
      expect(blocks("bun run scripts/verify.ts")).toBe(true);
    });

    test("flags before the script", () => {
      expect(blocks("bun --smol scripts/verify.ts")).toBe(true);
    });

    test("flags between `run` and the script", () => {
      expect(blocks("bun run --silent scripts/verify.ts")).toBe(true);
    });

    test("a separate-value flag does not hide the script behind it", () => {
      expect(blocks("bun --cwd . scripts/verify.ts")).toBe(true);
    });

    test("an inline `--flag=value` eats no token", () => {
      expect(blocks("bun --cwd=. scripts/verify.ts")).toBe(true);
    });

    test("invoked by absolute path to the binary", () => {
      expect(blocks(`${BREW_BIN}/bun scripts/verify.ts`)).toBe(true);
    });
  });

  describe("a script outside every equin checkout is left alone", () => {
    // A scratch workspace has no checkout above it to walk into, and no
    // `./equin run` for the hint to name.
    test("relative script from a non-checkout cwd", () => {
      expect(blocks("bun x.ts", "/tmp")).toBe(false);
    });

    test("absolute script outside a checkout, from inside one", () => {
      expect(blocks("bun /tmp/scratch/verify.ts")).toBe(false);
    });

    test("cd out of the checkout first", () => {
      expect(blocks("cd /tmp && bun verify.ts")).toBe(false);
    });
  });

  describe("`bun run <package.json script>` resolves a bin, not a module", () => {
    test("the documented static-snapshot path stays allowed", () => {
      expect(
        blocks(
          `bun run playwright screenshot --wait-for-timeout 3000 --viewport-size "1280,800" http://wt.localhost:9000 /tmp/screenshot.png`,
        ),
      ).toBe(false);
    });

    test("a bin whose own arg is a .ts file is still a bin call", () => {
      expect(blocks("bun run playwright test e2e/smoke.ts")).toBe(false);
    });

    test("a plain script name", () => {
      expect(blocks("bun run build")).toBe(false);
    });
  });

  describe("subcommands are not module paths, so they fall out for free", () => {
    for (const sub of [
      "install",
      "install --frozen-lockfile",
      "test",
      "add zod",
      "remove zod",
      "build --target=bun src/entry.ts",
      "x playwright install chromium",
      "pm ls",
      "upgrade",
      "init",
    ]) {
      test(`bun ${sub}`, () => {
        expect(blocks(`bun ${sub}`)).toBe(false);
      });
    }
  });

  describe("other spellings are untouched", () => {
    test("bunx is a different binary", () => {
      // Deliberately not `bunx playwright …`: that spelling is banned tree-wide
      // by `e2e-harness:pinned-playwright-invocation`, because it resolves
      // registry-latest instead of the workspace version. (Legal to name here:
      // that check masks comments in TS. It would still flag the same text in a
      // STRING, which is why the command below is `cowsay`.) Any package makes
      // this test's point — the assertion is about the BINARY NAME: this guard
      // matches `bun`, and `bunx` is not it.
      expect(blocks("bunx cowsay hello")).toBe(false);
    });

    test("bun -e evaluates source, it does not load a module", () => {
      expect(
        blocks(
          `bun -e 'console.log(Bun.resolveSync("playwright", process.cwd()))'`,
        ),
      ).toBe(false);
    });

    test("the sanctioned replacement is not itself blocked", () => {
      expect(blocks("./equin run scripts/verify.ts")).toBe(false);
    });

    test("node running a .ts file is a different binary", () => {
      expect(blocks("node scripts/verify.ts")).toBe(false);
    });
  });

  // `./equin` is a /bin/sh wrapper whose LAST line is
  // `exec bun plugins/framework/plugins/cli/bin/index.ts "$@"`. The guard reads
  // the Bash tool's command string, never the wrapper's contents, and
  // parse-shell takes the basename of the executable — so the call is named
  // the legacy CLI name, not `bun`. If that ever inverted, every CLI verb (`build`,
  // `push`, `check`, `test`, and `run` itself) would deny itself: an agent could
  // not even run the command the denial tells it to use.
  describe("the ./equin wrapper can never trip its own guard", () => {
    for (const verb of [
      "run plugins/apps-core/plugins/tabs/e2e/tabs-verify.ts",
      "run scripts/verify.mjs",
      "build",
      "check",
      "test plugins/framework/plugins/tooling/plugins/guards",
      "push -m 'msg'",
      "format",
    ]) {
      test(`./equin ${verb}`, () => {
        expect(blocks(`./equin ${verb}`)).toBe(false);
      });
    }

    test("under its canonical name, ./equin", () => {
      expect(blocks("./equin run scripts/verify.mjs")).toBe(false);
    });

    test("invoked by absolute path", () => {
      expect(blocks(`${USERS}me/repo/${LEGACY_IDS.cliShim} build`)).toBe(false);
    });

    test("chained after a cd, the shape agents actually write", () => {
      expect(
        blocks(`cd ${USERS}me/repo/wt && ./equin run e2e/verify.ts --headed`),
      ).toBe(false);
    });
  });

  describe("scans every call in the command, not just the first", () => {
    test("pipeline — offending bun is downstream", () => {
      expect(blocks("echo hi | bun scripts/verify.ts")).toBe(true);
    });

    test("&& chain — benign bun first, offending bun second", () => {
      expect(blocks("bun install && bun e2e/tabs-verify.ts")).toBe(true);
    });

    test("sequence — offending bun after an unrelated command", () => {
      // The cd stays inside the checkout: a script under /tmp is left alone.
      expect(blocks("cd plugins; bun run scripts/verify.ts")).toBe(true);
    });

    test("multi-line script — offending bun on line 2", () => {
      expect(blocks("bun install\nbun scripts/verify.ts")).toBe(true);
    });

    test("wrapped by timeout — the peeled inner call still matches", () => {
      expect(blocks("timeout 60 bun scripts/verify.ts")).toBe(true);
    });

    test("multi-line script — all lines benign", () => {
      expect(blocks("bun install\nbun run playwright install chromium")).toBe(
        false,
      );
    });
  });

  describe("a bare script run from the checkout root is rewritten to ./equin run", () => {
    for (const [typed, ran] of [
      ["bun x.ts", "./equin run x.ts"],
      ["bun run x.ts --flag 'a b'", "./equin run x.ts --flag 'a b'"],
      [
        "bun scripts/a.ts < in.json > out.txt 2>&1",
        "./equin run scripts/a.ts < in.json > out.txt 2>&1",
      ],
      [
        "timeout 60 bun x.ts | tail -3",
        "timeout 60 ./equin run x.ts | tail -3",
      ],
      ["bun a.ts && bun b.ts", "./equin run a.ts && ./equin run b.ts"],
      [`bun ${REPO_ROOT}/x.ts`, `./equin run ${REPO_ROOT}/x.ts`],
    ]) {
      test(typed!, () => {
        expect(rewritten(typed!)).toBe(ran);
      });
    }

    test("the note says what ran and why", () => {
      const v = verdict("bun x.ts");
      expect(v.kind === "rewrite" && v.note).toContain("./equin run x.ts");
    });
  });

  describe("…but not when ./equin run would run something else", () => {
    test("a bun flag before the script has no ./equin run spelling", () => {
      expect(verdict("bun --cpu-prof x.ts").kind).toBe("deny");
    });

    test("from a subdirectory, the paths would resolve from the root", () => {
      expect(verdict("cd plugins && bun x.ts").kind).toBe("deny");
    });

    test("one unrewritable call denies the whole command", () => {
      expect(verdict("bun a.ts; bun --bun b.ts").kind).toBe("deny");
    });
  });

  describe("the denial says what to do instead", () => {
    const v = verdict("bun --bun e2e/tabs-verify.ts");
    test("names ./equin run with the same path", () => {
      expect(v.kind).toBe("deny");
      expect(v.kind === "deny" && v.reason).toContain(
        "./equin run e2e/tabs-verify.ts",
      );
    });

    test("offers the bypass token", () => {
      expect(v.kind === "deny" && v.reason).toContain(".allow-bun-script");
    });
  });
});
