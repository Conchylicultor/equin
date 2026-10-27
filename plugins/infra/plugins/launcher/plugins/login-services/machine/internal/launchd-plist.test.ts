import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { LoginServiceSpec } from "../../core";
import { parseLaunchAgentPlist, renderLaunchAgentPlist } from "./launchd-plist";

const job: LoginServiceSpec = {
  label: "dev.example.service",
  session: "background",
  description: "equin gateway",
  argv: [
    "/h/me/.equin/cache/deps/gateway-binary/abc/env/gateway",
    "-listen",
    ":9000",
    "-child-env",
    "A,B_*",
  ],
  cwd: "/h/me/.equin/cache/deps/gateway-binary/abc/env",
  env: { PATH: "/shims:/usr/bin", HOME: "/h/me", Q: `a&b<c>"d"` },
  stdioLog: "/h/me/logs/gateway-stdio.log",
};

describe("renderLaunchAgentPlist", () => {
  const xml = renderLaunchAgentPlist(job);

  test("carries the argv in order, the cwd and the stdio log", () => {
    const strings = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map(
      (m) => m[1],
    );
    // strings[0] is the Label; the argv follows it.
    expect(strings.slice(1, 1 + job.argv.length)).toEqual([...job.argv]);
    expect(xml).toContain(
      "<key>WorkingDirectory</key>\n\t<string>/h/me/.equin/cache/deps/gateway-binary/abc/env</string>",
    );
    expect(xml).toContain(
      `<key>StandardErrorPath</key>\n\t<string>${job.stdioLog}</string>`,
    );
  });

  test("escapes XML in values", () => {
    expect(xml).toContain("<string>a&amp;b&lt;c&gt;&quot;d&quot;</string>");
  });

  test("starts at load and relaunches only on an unsuccessful exit", () => {
    expect(xml).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(xml).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
  });

  test.skipIf(process.platform !== "darwin")("plutil accepts it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "plist-")), "job.plist");
    writeFileSync(path, xml);
    const res = await spawnCaptured(["plutil", "-lint", path], {
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
  });
});

describe("renderLaunchAgentPlist — the gateway's job, byte for byte", () => {
  test("a background job renders exactly the gateway plist", () => {
    expect(
      renderLaunchAgentPlist({
        label: "dev.example.service",
        session: "background",
        description: "equin gateway",
        argv: ["/bin/gw", "-x"],
        cwd: "/h/me/repo",
        env: { Z: "1", A: "2" },
        stdioLog: "/h/me/logs/gateway-stdio.log",
      }),
    ).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>dev.example.service</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/gw</string>
\t\t<string>-x</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>/h/me/repo</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>A</key>
\t\t<string>2</string>
\t\t<key>Z</key>
\t\t<string>1</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ExitTimeOut</key>
\t<integer>20</integer>
\t<key>StandardOutPath</key>
\t<string>/h/me/logs/gateway-stdio.log</string>
\t<key>StandardErrorPath</key>
\t<string>/h/me/logs/gateway-stdio.log</string>
</dict>
</plist>
`);
  });
});

describe("renderLaunchAgentPlist — a graphical service", () => {
  const xml = renderLaunchAgentPlist({
    ...job,
    label: "dev.equin.menu-bar",
    session: "graphical",
  });

  test("loads only into the Aqua (GUI) session", () => {
    expect(xml).toContain(
      "<key>Label</key>\n\t<string>dev.equin.menu-bar</string>\n\t<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>\n\t<key>ProgramArguments</key>",
    );
  });

  test("is the background plist plus that one key", () => {
    const background = renderLaunchAgentPlist({
      ...job,
      label: "dev.equin.menu-bar",
    });
    expect(
      xml.replace(
        "\t<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>\n",
        "",
      ),
    ).toBe(background);
    expect(background).not.toContain("LimitLoadToSessionType");
  });

  test.skipIf(process.platform !== "darwin")("plutil accepts it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "plist-")), "job.plist");
    writeFileSync(path, xml);
    const res = await spawnCaptured(["plutil", "-lint", path], {
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
  });
});

describe("parseLaunchAgentPlist", () => {
  test("reads back the argv and cwd it rendered, unescaped", () => {
    const argv = [...job.argv, `a&b<c>"d"`];
    expect(
      parseLaunchAgentPlist(renderLaunchAgentPlist({ ...job, argv })),
    ).toEqual({ argv, cwd: job.cwd });
  });

  test("a plist that is not one of ours is null", () => {
    expect(parseLaunchAgentPlist("<plist><dict></dict></plist>")).toBeNull();
  });
});
