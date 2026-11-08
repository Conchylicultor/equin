import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  judgePidFile,
  psProbeArgv,
  readPsProbe,
  type ProcessSnapshot,
} from "./pid-file-holder";

const DATA_DIR = "/home/u/.equin/postgres/data-pg18";
const PG_LOCK = `4242\n${DATA_DIR}\n1793824090\n5433\n/home/u/.equin/postgres/socket\n\n  4927358    196609\nready   \n`;
const WRITTEN = Date.parse("2026-11-08T12:00:00Z");
const POSTMASTER = `/x/native/bin/postgres -D ${DATA_DIR} -k /s -p 5433 -c listen_addresses=`;

function running(
  args: string,
  over: Partial<{ uid: number; startedAtMs: number }> = {},
): ProcessSnapshot {
  return {
    kind: "running",
    uid: 501,
    startedAtMs: WRITTEN - 1_000,
    args,
    ...over,
  };
}

function judge(text: string | null, proc: ProcessSnapshot) {
  const asked: number[] = [];
  const holder = judgePidFile(
    text === null ? null : { text, mtimeMs: WRITTEN },
    {
      uid: 501,
      executable: "postgres",
      argvMarker: DATA_DIR,
      probe: (pid) => {
        asked.push(pid);
        return proc;
      },
    },
  );
  return { holder, asked };
}

describe("judgePidFile", () => {
  test("no file: absent, nothing probed", () => {
    const { holder, asked } = judge(null, { kind: "gone" });
    expect(holder).toEqual({ kind: "absent" });
    expect(asked).toEqual([]);
  });

  test("the daemon itself: live, judged by the pid on the first line", () => {
    const { holder, asked } = judge(PG_LOCK, running(POSTMASTER));
    expect(holder).toEqual({ kind: "live", pid: 4242 });
    expect(asked).toEqual([4242]);
  });

  test("the daemon is live whatever the clocks say (identity alone decides)", () => {
    expect(
      judge(PG_LOCK, running(POSTMASTER, { startedAtMs: WRITTEN + 3_600_000 }))
        .holder,
    ).toEqual({ kind: "live", pid: 4242 });
  });

  test("an executable named on its own, and a path with spaces", () => {
    expect(judge(PG_LOCK, running(`postgres -D ${DATA_DIR}`)).holder.kind).toBe(
      "live",
    );
    expect(
      judge(PG_LOCK, running(`/a b/bin/postgres -D ${DATA_DIR}`)).holder.kind,
    ).toBe("live");
  });

  test("a marker at the end of the command line (PgBouncer's config file)", () => {
    const ini = "/home/u/.equin/postgres/pgbouncer.ini";
    for (const args of [`/b/pgbouncer ${ini}`, `/b/pgbouncer ${ini} -d`]) {
      const holder = judgePidFile(
        { text: "777\n", mtimeMs: WRITTEN },
        {
          uid: 501,
          executable: "pgbouncer",
          argvMarker: ini,
          probe: () => running(args),
        },
      );
      expect(holder).toEqual({ kind: "live", pid: 777 });
    }
  });

  test("no such process: stale", () => {
    expect(judge(PG_LOCK, { kind: "gone" }).holder).toMatchObject({
      kind: "stale",
      pid: 4242,
    });
  });

  test("another user's process (the pid reused): stale", () => {
    expect(
      judge(PG_LOCK, running("/sbin/launchd", { uid: 0 })).holder,
    ).toMatchObject({ kind: "stale", pid: 4242 });
  });

  test("one of ours, not the daemon, started after the file was written: stale (the pid reused)", () => {
    expect(
      judge(
        PG_LOCK,
        running("/x/bin/vim notes", { startedAtMs: WRITTEN + 60_000 }),
      ).holder,
    ).toMatchObject({ kind: "stale", pid: 4242 });
  });

  test("one of ours, not the daemon, running since before the file: foreign, never stale", () => {
    expect(judge(PG_LOCK, running("/x/bin/vim notes")).holder).toEqual({
      kind: "foreign",
      pid: 4242,
      args: "/x/bin/vim notes",
    });
  });

  test("a start within the elapsed-time rounding of the write is still the writer", () => {
    expect(
      judge(
        PG_LOCK,
        running("/x/bin/vim notes", { startedAtMs: WRITTEN + 1_500 }),
      ).holder.kind,
    ).toBe("foreign");
  });

  test("the marker alone is not the daemon: another program naming the data dir", () => {
    expect(judge(PG_LOCK, running(`/x/bin/tail ${DATA_DIR}`)).holder.kind).toBe(
      "foreign",
    );
  });

  test("the marker must be a whole argument, not a prefix of one", () => {
    expect(
      judge(PG_LOCK, running(`/x/postgres -D ${DATA_DIR}0`)).holder.kind,
    ).toBe("foreign");
  });

  test.each(["", "\n", "abc\n", "0\n", "-3\n"])(
    "no pid on the first line (%j): unreadable, nothing probed",
    (text) => {
      const { holder, asked } = judge(text, { kind: "gone" });
      expect(holder).toEqual({ kind: "unreadable", text });
      expect(asked).toEqual([]);
    },
  );
});

describe("readPsProbe", () => {
  const NOW = Date.parse("2026-11-08T12:00:00Z");

  test("exit 1, silent: gone", () => {
    expect(readPsProbe(5, { status: 1, stdout: "", stderr: "" }, NOW)).toEqual({
      kind: "gone",
    });
  });

  test.each([
    ["00:07", 7],
    ["03:07", 3 * 60 + 7],
    ["02:03:07", (2 * 60 + 3) * 60 + 7],
    ["59-20:34:41", ((59 * 24 + 20) * 60 + 34) * 60 + 41],
  ])("a row with elapsed %s: running, started that long ago", (etime, s) => {
    expect(
      readPsProbe(
        5,
        {
          status: 0,
          stdout: `  501 ${etime} /a b/postgres -D /d -c listen_addresses=\n`,
          stderr: "",
        },
        NOW,
      ),
    ).toEqual({
      kind: "running",
      uid: 501,
      startedAtMs: NOW - s * 1000,
      args: "/a b/postgres -D /d -c listen_addresses=",
    });
  });

  test.each([
    { status: null, stdout: "", stderr: "" },
    { status: 1, stdout: "", stderr: "ps: illegal option" },
    { status: 1, stdout: "", stderr: "ps: process id too large: 999999" },
    { status: 0, stdout: "garbage", stderr: "" },
    { status: 0, stdout: "501 soon /bin/x", stderr: "" },
    { status: 2, stdout: "", stderr: "" },
  ])("anything else proves nothing and throws (%j)", (ps) => {
    expect(() => readPsProbe(5, ps, NOW)).toThrow(/ps could not say/);
  });
});

describe("psProbeArgv against the real ps", () => {
  function run(pid: number) {
    const [cmd, ...args] = psProbeArgv(pid);
    const r = spawnSync(cmd!, args, { encoding: "utf8" });
    return readPsProbe(
      pid,
      { status: r.status, stdout: r.stdout, stderr: r.stderr },
      Date.now(),
    );
  }

  test("a live child: running as us, just started, its command line in full", () => {
    const marker = `/tmp/pid-file-holder-${"m".repeat(300)}.ini`;
    // `; true` keeps sh from exec-ing sleep, so the child keeps its own argv.
    const child = spawn("/bin/sh", ["-c", "sleep 60; true", "sh", marker]);
    try {
      const snap = run(child.pid!);
      expect(snap).toMatchObject({ kind: "running", uid: process.getuid!() });
      if (snap.kind === "running")
        expect(Math.abs(Date.now() - snap.startedAtMs)).toBeLessThan(5_000);
      const holder = judgePidFile(
        { text: `${child.pid}\n`, mtimeMs: Date.now() },
        {
          uid: process.getuid!(),
          executable: "sh",
          argvMarker: marker,
          probe: run,
        },
      );
      expect(holder).toEqual({ kind: "live", pid: child.pid! });
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("a reaped child's pid: gone", () => {
    const child = spawnSync("true");
    expect(child.pid).toBeGreaterThan(0);
    expect(run(child.pid)).toEqual({ kind: "gone" });
  });
});
