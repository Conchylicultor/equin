import { describe, expect, test } from "bun:test";
import {
  classify,
  closedWindowEnd,
  detectPoll,
  watchSubjects,
  THRESHOLD,
  type WindowEntry,
} from "./poll-detect";
import { parseShell } from "./parse-shell";

const TASK =
  "/private/tmp/claude-501/-Users-epot-repo--worktrees-att-1/abc-def/tasks/bjr1kagwr.output";

/** Feed commands in order and report the index of the one that trips. */
function firstTrip(commands: string[], stepMs = 5000): number | null {
  let window: WindowEntry[] = [];
  let now = 0;
  for (const [i, cmd] of commands.entries()) {
    now += stepMs;
    const kind = classify(cmd);
    if (kind === "mutate") {
      window = [];
      continue;
    }
    if (kind === "neutral") continue;
    const subjects = watchSubjects(cmd);
    if (detectPoll(subjects, window, now).tripped) return i;
    window.push({ t: now, s: subjects });
  }
  return null;
}

describe("watchSubjects", () => {
  test("a background task's output file", () => {
    expect(watchSubjects(`cat ${TASK}`)).toEqual(["task:bjr1kagwr"]);
  });

  test("digits are normalised, so tail -25 and tail -40 are one watch", () => {
    expect(watchSubjects(`cat ${TASK} | tail -25`)).toEqual(
      watchSubjects(`cat ${TASK} | tail -40`),
    );
  });

  test("a build receipt names its worktree", () => {
    expect(
      watchSubjects(
        // Fake root, deliberately not under /Users or ~ — `paths:no-hardcoded-paths`.
        "jq -r '.status' /r/data/worktrees/att-1-a/build-status.json",
      ),
    ).toEqual(["receipt:build:att-1-a"]);
  });

  test("a pgrep pattern", () => {
    expect(watchSubjects(`pgrep -f "equin push"`)).toEqual(["proc:equin push"]);
  });

  test("kill -0 names the pid", () => {
    expect(watchSubjects("kill -0 41996")).toEqual(["pid:41996"]);
  });

  test("remote git state", () => {
    expect(watchSubjects("git ls-remote --heads origin my-branch")).toEqual([
      "git:remote",
    ]);
  });

  test("a command watching nothing has no subjects", () => {
    expect(watchSubjects("ls -la src")).toEqual([]);
  });

  describe("a bare sleep watches the clock", () => {
    // Regression: `sleep 300; echo TICK` repeated 9x was invisible, because it
    // names no file and no process. Waiting on time IS the pathology.
    test("sleep alone", () => {
      expect(watchSubjects("sleep 300")).toEqual(["time:sleep"]);
    });

    test("sleep with a marker echo", () => {
      expect(watchSubjects("sleep 420; echo waited")).toEqual(["time:sleep"]);
    });

    test("but not when it is waiting on something identifiable", () => {
      expect(
        watchSubjects("sleep 5; curl -s http://x.localhost:9000/"),
      ).toEqual(["url:http://x.localhost:#/"]);
    });
  });

  describe("a command that does nothing passes time", () => {
    // Regression: conv-1787490197-3p4n waited six hours on `echo w1`,
    // `echo w2`, … — no subject, so every call was `neutral` and never counted.
    test("an echo of fixed text", () => {
      expect(watchSubjects("echo w65")).toEqual(["time:no-op"]);
    });

    test("any chain of no-ops", () => {
      expect(watchSubjects(`echo "waiting"; printf idle; true; :`)).toEqual([
        "time:no-op",
      ]);
    });

    test("a sleep keeps its own subject", () => {
      expect(watchSubjects("sleep 1; echo waited")).toEqual(["time:sleep"]);
    });

    test("printing a variable reads state, so it is not a no-op", () => {
      expect(watchSubjects("echo $HOME")).toEqual([]);
    });

    test("an echo beside real work is not a no-op", () => {
      expect(watchSubjects(`echo "=== a ==="; cat src/a.ts`)).toEqual([]);
    });
  });
});

describe("log subjects are per file, never per family", () => {
  // Fake root, deliberately not under /Users or ~ — `paths:no-hardcoded-paths`.
  const RUN = "/r/data/worktrees/att-1-a/runs/build-build-1794163461-h5cz9l";

  test("a run transcript keeps its path, even through a variable", () => {
    expect(
      watchSubjects(`L=${RUN}.log; stat -f '%Sm' $L; rg -n "locked" $L`),
    ).toEqual([`run:${RUN}`]);
  });

  test("two builds' logs are two subjects", () => {
    expect(
      watchSubjects("cat /r/w/build-build-1-a.log /r/w/check-build-2-b.log"),
    ).toEqual(["log-file:build-build-1-a", "log-file:check-build-2-b"]);
  });

  test("the build timeline is its own subject, not a build log", () => {
    expect(watchSubjects("rg x /r/data/build-progress.jsonl")).toEqual([
      "log:build-progress",
    ]);
  });
});

describe("closedWindowEnd", () => {
  const at = (iso: string) => Date.parse(iso);
  const end = (cmd: string, now: string) =>
    closedWindowEnd(parseShell(cmd), at(now));

  test("a minute-tens prefix ends at the next ten minutes", () => {
    expect(end(`rg '"t":"2026-11-08T18:4[67]' f`, "2026-11-08T19:00Z")).toBe(
      at("2026-11-08T18:50Z"),
    );
  });

  test("the incident's pipeline: an rg -v on another call does not count", () => {
    expect(
      end(
        `rg -n '"t":"2026-11-08T18:4[67]' f | rg -v '"phase":"pending"'`,
        "2026-11-08T19:00Z",
      ),
    ).toBe(at("2026-11-08T18:50Z"));
  });

  test("a window still open names nothing closed", () => {
    expect(end(`rg '"t":"2026-11-08T18:4' f`, "2026-11-08T18:47Z")).toBeNull();
  });

  test("every timestamp must be closed — one live alternative keeps it open", () => {
    expect(
      end(`rg '2026-11-08T17|2026-11-08T19' f`, "2026-11-08T18:30Z"),
    ).toBeNull();
  });

  test("a date the parser cannot read keeps it open", () => {
    expect(
      end(`rg '2026-11-07|2026-11-0[89]' f`, "2026-11-08T12:00Z"),
    ).toBeNull();
  });

  test("a past date that selects nothing is no window", () => {
    const now = "2026-11-08T12:00Z";
    expect(end("tail -50 f | rg -v 2026-11-01", now)).toBeNull();
    expect(end("echo 2026-11-01; tail -5 f", now)).toBeNull();
  });

  test("a day prefix spans the whole day", () => {
    expect(end("rg 2026-11-07 f", "2026-11-08T00:00Z")).toBe(
      at("2026-11-08T00:00Z"),
    );
  });

  test("no timestamp, no window", () => {
    expect(end("tail -5 f", "2026-11-08T00:00Z")).toBeNull();
  });
});

describe("a document that mentions a file is not watching it", () => {
  test("log paths inside a heredoc body name no subject", () => {
    const cmd = [
      "cat > notes.md <<'EOF'",
      "Read `logs/build.jsonl` and the receipt at build-status.json,",
      "plus the captured output under tasks/abc123.output.",
      "EOF",
    ].join("\n");
    expect(watchSubjects(cmd)).toEqual([]);
  });

  test("but a real read of the same log still does", () => {
    expect(watchSubjects("rg x logs/agent.jsonl")).toEqual(["log:agent"]);
  });
});

describe("classify", () => {
  test("reading a task output file is an observation", () => {
    expect(classify(`cat ${TASK} | tail -30`)).toBe("observe");
  });

  test("the real loop from conv-1786116592-b70n", () => {
    expect(
      classify(
        `cat ${TASK} 2>/dev/null | tail -40; pgrep -f "equin push" >/dev/null && echo running || echo finished`,
      ),
    ).toBe("observe");
  });

  test("an until/sleep waiter is an observation, not progress", () => {
    expect(
      classify(
        `until ! pgrep -f "equin build" >/dev/null 2>&1; do sleep 5; done`,
      ),
    ).toBe("observe");
  });

  test("running a build is progress", () => {
    expect(classify("./equin build")).toBe("mutate");
  });

  test("a write redirection is progress", () => {
    expect(classify(`cat ${TASK} > /tmp/saved.txt`)).toBe("mutate");
  });

  test("> /dev/null is not a write", () => {
    expect(classify(`pgrep -f "equin build" >/dev/null && echo yes`)).toBe(
      "observe",
    );
  });

  test("a writing git subcommand is progress", () => {
    expect(classify("git commit -m x")).toBe("mutate");
  });

  test("kill -0 probes, other kills signal", () => {
    expect(classify("kill -0 123")).toBe("observe");
    expect(classify("kill -9 123")).toBe("mutate");
  });

  test("a read-only command watching nothing is neutral", () => {
    expect(classify("ls -la src")).toBe("neutral");
  });

  test("an unrecognised command is neutral, NOT progress", () => {
    // Regression: treating unknown as progress reset the window and missed the
    // largest loop in the corpus (163 pgrep calls whose company was `uptime`).
    expect(classify("uptime")).toBe("neutral");
  });
});

describe("detectPoll", () => {
  test(`trips on the ${THRESHOLD}th look at the same subject`, () => {
    const cmds = Array.from(
      { length: 6 },
      (_, i) => `cat ${TASK} | tail -${20 + i * 5}`,
    );
    expect(firstTrip(cmds)).toBe(THRESHOLD - 1);
  });

  test("drifting commands do not help — the subject is the identity", () => {
    expect(
      firstTrip([
        `cat ${TASK}`,
        `cat ${TASK} | tail -25`,
        `tail -30 ${TASK}; pgrep -f "equin push"`,
        `wc -l ${TASK}`,
      ]),
    ).toBe(3);
  });

  test("different subjects never accumulate", () => {
    expect(
      firstTrip([
        "cat /x/tasks/aaaaaaaaa.output",
        "cat /x/tasks/bbbbbbbbb.output",
        "cat /x/tasks/ccccccccc.output",
        "cat /x/tasks/ddddddddd.output",
        "cat /x/tasks/eeeeeeeee.output",
      ]),
    ).toBeNull();
  });

  test("real work in between resets the window", () => {
    expect(
      firstTrip([
        `cat ${TASK}`,
        `cat ${TASK}`,
        `cat ${TASK}`,
        "./equin build",
        `cat ${TASK}`,
        `cat ${TASK}`,
      ]),
    ).toBeNull();
  });

  test("neutral commands neither count nor reset", () => {
    expect(
      firstTrip([
        `cat ${TASK}`,
        "uptime",
        `cat ${TASK}`,
        "ls src",
        `cat ${TASK}`,
        "uptime",
        `cat ${TASK}`,
      ]),
    ).toBe(6);
  });

  test("looks spread beyond the window do not accumulate", () => {
    const cmds = Array.from({ length: 6 }, () => `cat ${TASK}`);
    expect(firstTrip(cmds, 11 * 60 * 1000)).toBeNull();
  });

  test("a counter in the text does not help a no-op loop", () => {
    const cmds = Array.from({ length: 6 }, (_, i) => `echo w${i + 1}`);
    expect(firstTrip(cmds)).toBe(THRESHOLD - 1);
  });

  test("an echo written to a file is work, not a wait", () => {
    expect(classify("echo done > notes.txt")).toBe("mutate");
  });

  test("three looks are fine — the threshold is four", () => {
    expect(firstTrip([`cat ${TASK}`, `cat ${TASK}`, `cat ${TASK}`])).toBeNull();
  });
});

describe("classify reads redirections, not the word after `>`", () => {
  test("a fd duplication is not a write, so a waiter stays a waiter", () => {
    expect(classify("ls >&2")).not.toBe("mutate");
  });

  test("`>|` writes a file, so the command is a mutation", () => {
    expect(classify(`cat ${TASK} >| /tmp/saved.txt`)).toBe("mutate");
  });
});
