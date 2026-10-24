import { describe, expect, test } from "bun:test";
import type { LoginServiceSpec } from "../../core";
import { parseSystemdUserUnit, renderSystemdUserUnit } from "./systemd-unit";

const job: LoginServiceSpec = {
  label: "dev.singularity.gateway",
  session: "background",
  description: "equin gateway",
  argv: [
    "/h/me/.singularity/cache/deps/gateway-binary/abc/env/gateway",
    "-listen",
    "127.0.0.1:9000",
    "-child-env",
    "A,B_*",
  ],
  cwd: "/h/me/repo",
  env: { PATH: "/shims:/usr/bin", HOME: "/h/me", Q: `a"b\\c 50% $x` },
  stdioLog: "/h/me/logs/gateway-stdio.log",
};

describe("renderSystemdUserUnit", () => {
  const unit = renderSystemdUserUnit(job);

  test("carries the argv in order, quoted, and the cwd", () => {
    expect(unit).toContain(
      `ExecStart="${job.argv[0]}" "-listen" "127.0.0.1:9000" "-child-env" "A,B_*"`,
    );
    // Unquoted: systemd takes a path setting verbatim.
    expect(unit).toContain("WorkingDirectory=/h/me/repo\n");
  });

  test("escapes quotes, backslashes and specifiers in env values", () => {
    expect(unit).toContain(`Environment="Q=a\\"b\\\\c 50%% $x"`);
  });

  test("escapes $ in ExecStart only", () => {
    const u = renderSystemdUserUnit({ ...job, argv: ["/bin/gw", "$HOME"] });
    expect(u).toContain(`ExecStart="/bin/gw" "$$HOME"`);
  });

  test("env is sorted, so the file is stable across starts", () => {
    const keys = [...unit.matchAll(/^Environment="([A-Z]+)=/gm)].map(
      (m) => m[1],
    );
    expect(keys).toEqual(["HOME", "PATH", "Q"]);
  });

  test("the relaunch policy matches the launchd job's", () => {
    expect(unit).toContain(
      "Restart=on-failure\nRestartSec=10\nTimeoutStopSec=20",
    );
    // A stop signals the gateway alone: every running agent process shares
    // its cgroup.
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain(`StandardOutput=append:${job.stdioLog}`);
    expect(unit).toContain("WantedBy=default.target");
  });

  test("refuses a value with a newline", () => {
    expect(() =>
      renderSystemdUserUnit({ ...job, env: { BAD: "a\nb" } }),
    ).toThrow(/newline/);
  });
});

describe("renderSystemdUserUnit — the gateway's unit, byte for byte", () => {
  test("a background unit renders exactly the gateway unit", () => {
    expect(
      renderSystemdUserUnit({
        label: "dev.singularity.gateway",
        session: "background",
        description:
          "equin gateway (and through it Postgres, PgBouncer and every backend)",
        argv: ["/bin/gw", "-x"],
        cwd: "/h/me/repo",
        env: { Z: "1", A: "2" },
        stdioLog: "/h/me/logs/gateway-stdio.log",
      }),
    ).toBe(`[Unit]
Description=equin gateway (and through it Postgres, PgBouncer and every backend)

[Service]
Type=simple
ExecStart="/bin/gw" "-x"
WorkingDirectory=/h/me/repo
Environment="A=2"
Environment="Z=1"
Restart=on-failure
RestartSec=10
TimeoutStopSec=20
KillMode=process
StandardOutput=append:/h/me/logs/gateway-stdio.log
StandardError=append:/h/me/logs/gateway-stdio.log

[Install]
WantedBy=default.target
`);
  });
});

describe("renderSystemdUserUnit — a graphical service", () => {
  const unit = renderSystemdUserUnit({
    ...job,
    label: "dev.equin.menu-bar",
    session: "graphical",
  });

  test("belongs to the graphical session, not the user manager at large", () => {
    expect(unit).toContain(
      "PartOf=graphical-session.target\nAfter=graphical-session.target\n\n[Service]",
    );
    expect(unit).toContain("WantedBy=graphical-session.target\n");
    expect(unit).not.toContain("default.target");
  });

  test("keeps the background unit's relaunch policy", () => {
    expect(unit).toContain(
      "Restart=on-failure\nRestartSec=10\nTimeoutStopSec=20\nKillMode=process",
    );
  });
});

describe("parseSystemdUserUnit", () => {
  test("reads back the argv and cwd it rendered, unescaped", () => {
    const argv = [...job.argv, `a"b\\c 50% $x $$y`, ""];
    const cwd = "/h/me/50%/repo";
    expect(
      parseSystemdUserUnit(renderSystemdUserUnit({ ...job, argv, cwd })),
    ).toEqual({ argv, cwd });
  });

  test("a unit that is not one of ours is null", () => {
    expect(parseSystemdUserUnit("[Service]\nType=simple\n")).toBeNull();
    expect(
      parseSystemdUserUnit("ExecStart=/bin/gw -x\nWorkingDirectory=/\n"),
    ).toBeNull();
  });
});
