/**
 * The activate script only ever executes on a remote host, after the flip — so
 * a shell typo in its gate is discovered by a production ship. Checkable here:
 *
 * - `bash -n` parses the generated script.
 * - `SETTLE_GATE_SH` is run in a real bash (`set -euo pipefail`, as on the
 *   host) against a stubbed `curl` answering a scripted sequence of
 *   `/api/health` bodies, asserting its whole decision table.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMOTE_SCRIPT_SHEBANG,
  deriveInstall,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { SETTLE_GATE_SH, activateScript } from "./activate-script";
import {
  ACTIVATE_MS,
  READY_ATTEMPTS,
  READY_INTERVAL_SEC,
  SETTLE_DEADLINE_SEC,
} from "./target";

const tmp = mkdtempSync(join(tmpdir(), "activate-script-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function bash(
  source: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", source], {
    cwd: tmp,
    env: { ...process.env, ...env },
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

test("the generated activate script parses", async () => {
  const script = activateScript({
    install: deriveInstall("website"),
    runId: "run-1",
    binaryName: "equin-website",
    loopbackPort: 9100,
  });
  const path = join(tmp, "activate.sh");
  writeFileSync(path, script);
  const r = await bash(`bash -n ${path}`);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
});

test("the ssh deadline outlasts the whole health gate", () => {
  // Otherwise ssh kills the script mid-gate: after the flip, before the revert.
  expect(ACTIVATE_MS / 1000).toBeGreaterThan(
    READY_ATTEMPTS * READY_INTERVAL_SEC + SETTLE_DEADLINE_SEC,
  );
});

describe("SETTLE_GATE_SH", () => {
  let n = 0;
  const health = (startedAt: number, boot?: string) =>
    JSON.stringify({
      ok: true,
      startedAt,
      ...(boot === undefined ? {} : { boot }),
      runId: "run-1",
      composition: "website",
    });

  /**
   * Run the gate for process `incarnation` against `answers` — one `curl` call
   * each, `null` a failed call; past the end the last one repeats. The
   * deadline is generous (`far`) for the cases that end before it; `expires`
   * is 2 s — bash's `SECONDS` counts whole seconds, so a 1 s bound could pass
   * before a second call. The silence window is 1 s or 60 s.
   */
  async function gate(
    answers: (string | null)[],
    opts: { deadline?: "expires" | "far"; silence?: "short" | "long" } = {},
  ) {
    const { deadline = "far", silence = "long" } = opts;
    const dir = join(tmp, `case-${n++}`);
    mkdirSync(join(dir, "bin"), { recursive: true });
    answers.forEach((a, i) => {
      if (a !== null) writeFileSync(join(dir, `answer-${i}`), a);
    });
    const curl = join(dir, "bin", "curl");
    writeFileSync(
      curl,
      `${REMOTE_SCRIPT_SHEBANG}
i="$(cat ${dir}/calls 2>/dev/null || echo 0)"
echo $(( i + 1 )) > ${dir}/calls
[ "$i" -lt ${answers.length - 1} ] || i=${answers.length - 1}
[ -e ${dir}/answer-$i ] || exit 7
cat ${dir}/answer-$i
`,
    );
    chmodSync(curl, 0o755);
    const r = await bash(
      `set -euo pipefail
${SETTLE_GATE_SH}
status=0
settle_gate http://127.0.0.1:9100/api/health 1000 || status=$?
echo "$status|$SETTLE_DETAIL"`,
      {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        SETTLE_DEADLINE_SEC: deadline === "expires" ? "2" : "60",
        SETTLE_SILENCE_SEC: silence === "short" ? "1" : "60",
        SETTLE_INTERVAL_SEC: "0.1",
      },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const [status, detail] = r.stdout.trim().split("|");
    return { status: Number(status), detail };
  }

  test("settled: the process that took over reports it", async () => {
    const r = await gate([
      health(1000, "ready"),
      null,
      health(1000, "settled"),
    ]);
    expect(r.status).toBe(0);
  });

  test("died: another process answers in its place", async () => {
    const r = await gate([health(1000, "ready"), null, health(2000, "ready")]);
    expect(r.status).toBe(1);
    expect(r.detail).toContain("startedAt 2000");
  });

  test("a successor that settles is still a death, not a pass", async () => {
    const r = await gate([health(2000, "settled")]);
    expect(r.status).toBe(1);
  });

  test("unproven: the same process still answers, unsettled", async () => {
    const r = await gate([health(1000, "ready")], { deadline: "expires" });
    expect(r.status).toBe(2);
    expect(r.detail).toContain("boot: ready");
  });

  test("a bundle without the boot field is never read as settled", async () => {
    const r = await gate([health(1000)], { deadline: "expires" });
    expect(r.status).toBe(2);
    expect(r.detail).toContain("boot: not reported");
  });

  test("silent: no answer for the silence window when the deadline passes", async () => {
    const r = await gate([null], { deadline: "expires", silence: "short" });
    expect(r.status).toBe(3);
    expect(r.detail).toContain("has not answered");
  });

  test("a missed poll inside the silence window is not a death", async () => {
    const r = await gate([health(1000, "ready"), null], {
      deadline: "expires",
    });
    expect(r.status).toBe(2);
    expect(r.detail).toContain("boot: ready");
  });
});
