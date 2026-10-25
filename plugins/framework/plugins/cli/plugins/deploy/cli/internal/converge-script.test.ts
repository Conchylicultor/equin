/**
 * The converge script only ever executes on a remote host, behind an scp and a
 * 15-minute budget — so without these tests a shell typo in it is discovered in
 * production, and its idempotence is discoverable only by watching a live site
 * restart. Both are checkable here:
 *
 * - `bash -n` parses the generated script (both branches of the hostname
 *   conditional), which is the check a live host would otherwise perform.
 * - `PUT_HELPER_SH` is sourced into a real bash and run against real files. It
 *   is the linchpin of the whole fix: the restart gate reads mtimes, and mtimes
 *   only mean anything because `put` leaves an unchanged file alone.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveInstall } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import {
  PUT_HELPER_SH,
  RESTART_GATE_SH,
  caddySite,
  convergeScript,
} from "./converge-script";

const tmp = mkdtempSync(join(tmpdir(), "converge-script-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const script = (hostnames: string[]) =>
  convergeScript({
    install: deriveInstall("website"),
    hostnames,
    loopbackPort: 9100,
    sshPort: 22,
    sshUser: "root",
    secretKeys: ["RESEND_API_KEY"],
  });

/** Run one bash snippet, returning its status and streams. */
async function bash(
  source: string,
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", source], {
    cwd: opts.cwd ?? tmp,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("caddySite", () => {
  test("refuses the host-only routes publicly, ahead of the proxy", () => {
    expect(caddySite(["equin.dev", "www.equin.dev"], 9100)).toBe(
      `equin.dev, www.equin.dev {
\tencode zstd gzip
\trespond /api/host-only/* 404
\theader /assets/* Cache-Control "public, max-age=31536000, immutable"
\treverse_proxy 127.0.0.1:9100
}
`,
    );
  });

  test("the refused path is the prefix hostOnly() guards", () => {
    expect(caddySite(["a.example"], 9100)).toContain(
      `respond ${HOST_ONLY_PREFIX}* 404`,
    );
  });
});

describe("convergeScript (shell syntax)", () => {
  for (const [label, hostnames] of [
    ["with hostnames", ["equin.ai", "www.equin.ai"]],
    ["without hostnames", []],
  ] as const) {
    test(`parses as bash — ${label}`, async () => {
      const path = join(tmp, `converge-${hostnames.length}.sh`);
      writeFileSync(path, script([...hostnames]));
      const result = await bash(`bash -n ${JSON.stringify(path)}`);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });
  }
});

describe("convergeScript (idempotence contract)", () => {
  test("every generated file lands through put", () => {
    const text = script(["equin.ai"]);
    // `mv -f "…​.new"` outside the helper means a step that replaces its file
    // unconditionally — which would bump the mtime the restart gate reads.
    const rawMoves = [...text.matchAll(/^mv -f "\$[A-Z_]+\.new"/gm)];
    expect(rawMoves).toHaveLength(0);
    for (const target of [
      "$ENV_FILE",
      "$CADDY_LIST",
      "$SITE",
      "$CADDYFILE",
      "$UNIT_PATH",
    ]) {
      expect(text).toContain(`if put "${target}"`);
    }
  });
});

/**
 * The restart gate, run for real against stubbed `systemctl` and `stat` and a
 * fake `/proc/stat`. The stubs return fixed numbers rather than reflecting a
 * host, because what is under test is the decision — which of the four states
 * ends in a `systemctl restart` — not GNU stat's flag spelling, which `bash -n`
 * and the live host cover.
 */
describe("the restart gate", () => {
  const BTIME = 1_000_000;
  const MONO_60S = 60_000_000; // µs since boot ⇒ the unit started at BTIME + 60

  let caseIndex = 0;
  async function gate(opts: {
    active?: boolean;
    /** `ExecMainStartTimestampMonotonic`, in µs. Empty string = never started. */
    mono?: string;
    envMtime: number;
    unitMtime: number;
  }): Promise<{ restarted: boolean; log: string }> {
    const dir = join(tmp, `gate-${caseIndex++}`);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(dir, "proc-stat"),
      `cpu 1 2 3\nbtime ${BTIME}\nprocesses 9\n`,
    );

    const restartMarker = join(dir, "restarted");
    writeFileSync(
      join(bin, "systemctl"),
      `#!/bin/bash
case "$1" in
  is-active) exit ${opts.active === false ? 1 : 0} ;;
  show) printf '%s\\n' ${JSON.stringify(opts.mono ?? String(MONO_60S))} ;;
  restart) : > ${JSON.stringify(restartMarker)} ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "stat"),
      `#!/bin/bash
# The gate calls \`stat -c %Y <path>\`; answer per file, deterministically.
case "\${3}" in
  *env) echo ${opts.envMtime} ;;
  *unit) echo ${opts.unitMtime} ;;
  *) echo 0 ;;
esac
`,
      { mode: 0o755 },
    );

    const result = await bash(
      `set -euo pipefail
export PATH=${JSON.stringify(bin)}:$PATH
export PROC_STAT=${JSON.stringify(join(dir, "proc-stat"))}
ENV_FILE=${JSON.stringify(join(dir, "env"))}
UNIT_PATH=${JSON.stringify(join(dir, "unit"))}
UNIT=equin@website.service
${RESTART_GATE_SH}`,
      { cwd: dir },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return { restarted: existsSync(restartMarker), log: result.stdout.trim() };
  }

  test("nothing shipped yet: the unit is enabled but not running", async () => {
    const r = await gate({
      active: false,
      envMtime: 1_000_100,
      unitMtime: 1_000_100,
    });
    expect(r.restarted).toBe(false);
    expect(r.log).toContain("nothing shipped yet");
  });

  test("unchanged host: the process is newer than its config", async () => {
    const r = await gate({ envMtime: BTIME + 50, unitMtime: BTIME + 50 });
    expect(r.restarted).toBe(false);
    expect(r.log).toContain("is current with");
  });

  test("a newer env restarts", async () => {
    const r = await gate({ envMtime: BTIME + 100, unitMtime: BTIME + 50 });
    expect(r.restarted).toBe(true);
    expect(r.log).toContain("configuration is newer than the running process");
  });

  test("a newer unit template restarts too — daemon-reload alone would not", async () => {
    const r = await gate({ envMtime: BTIME + 50, unitMtime: BTIME + 100 });
    expect(r.restarted).toBe(true);
  });

  test("same second as the restart counts as current, not as drift", async () => {
    // Otherwise every run would restart any install whose write and restart
    // landed within one second of each other.
    const r = await gate({ envMtime: BTIME + 60, unitMtime: BTIME + 60 });
    expect(r.restarted).toBe(false);
  });

  test("an unreadable start time restarts rather than assuming current", async () => {
    const r = await gate({
      mono: "",
      envMtime: BTIME + 50,
      unitMtime: BTIME + 50,
    });
    expect(r.restarted).toBe(true);
  });
});

describe("put", () => {
  /** `put <target> <mode> -` after staging `content` at `<target>.new`. */
  async function put(name: string, content: string, mode = "644") {
    const target = join(tmp, name);
    writeFileSync(`${target}.new`, content);
    return await bash(
      `set -euo pipefail\n${PUT_HELPER_SH}\nif put ${JSON.stringify(target)} ${mode} -; then echo CHANGED; else echo SAME; fi`,
    );
  }

  test("a missing target counts as changed, and the file lands", async () => {
    const result = await put("fresh", "hello\n");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("CHANGED");
    expect(readFileSync(join(tmp, "fresh"), "utf8")).toBe("hello\n");
  });

  test("an identical rewrite reports SAME and leaves the mtime untouched", async () => {
    await put("stable", "same bytes\n");
    const before = statSync(join(tmp, "stable")).mtimeMs;
    // A same-second rewrite would be indistinguishable at 1s granularity, which
    // is exactly the resolution the restart gate compares at.
    await Bun.sleep(1100);
    const result = await put("stable", "same bytes\n");

    expect(result.stdout.trim()).toBe("SAME");
    expect(statSync(join(tmp, "stable")).mtimeMs).toBe(before);
    // The staging file is not left behind for the next run to trip over.
    expect(() => statSync(join(tmp, "stable.new"))).toThrow();
  });

  test("differing content reports CHANGED and replaces the target", async () => {
    await put("drifting", "v1\n");
    const before = statSync(join(tmp, "drifting")).mtimeMs;
    await Bun.sleep(1100);
    const result = await put("drifting", "v2\n");

    expect(result.stdout.trim()).toBe("CHANGED");
    expect(readFileSync(join(tmp, "drifting"), "utf8")).toBe("v2\n");
    expect(statSync(join(tmp, "drifting")).mtimeMs).toBeGreaterThan(before);
  });

  test("a drifted mode is repaired on the unchanged path", async () => {
    await put("moded", "content\n", "600");
    chmodSync(join(tmp, "moded"), 0o777);
    const result = await put("moded", "content\n", "600");

    expect(result.stdout.trim()).toBe("SAME");
    expect(statSync(join(tmp, "moded")).mode & 0o777).toBe(0o600);
  });
});
