import { describe, expect, test } from "bun:test";
import { renderSystemdUserUnit } from "./systemd-unit";

const job = {
  description: "Singularity gateway",
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
    // A stop signals the gateway alone: the tmux server running every agent
    // shares its cgroup.
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
