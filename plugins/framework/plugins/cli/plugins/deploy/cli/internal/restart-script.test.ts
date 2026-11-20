/**
 * The restart script only ever runs on a remote host, against a site that is
 * down — so a shell typo is found exactly when the site needs it. Run here in a
 * real bash under `set -euo pipefail`, with `systemctl`, `journalctl` and
 * `curl` stubbed on PATH and the install's paths moved into a temp dir.
 */
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMOTE_SCRIPT_SHEBANG,
  UNIT_TEMPLATE_PATH,
  deriveInstall,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { restartScript } from "./restart-script";
import {
  READY_ATTEMPTS,
  READY_INTERVAL_SEC,
  RESTART_MS,
  SETTLE_DEADLINE_SEC,
} from "./target";

const tmp = mkdtempSync(join(tmpdir(), "restart-script-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;

/**
 * Run the generated script in a fresh case dir. `shipped` names the release
 * `current` points at (null: nothing shipped); `health` is what
 * `/api/health` answers; `restartFails` makes `systemctl restart` exit 1.
 */
async function runRestart(opts: {
  shipped: string | null;
  health?: string;
  restartFails?: boolean;
}): Promise<{ code: number; stderr: string; calls: string }> {
  const dir = join(tmp, `case-${n++}`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const install = {
    ...deriveInstall("website"),
    envFile: join(dir, "env"),
    currentLink: join(dir, "current"),
    dataDir: join(dir, "data"),
  };
  writeFileSync(install.envFile, "");
  const unitTemplate = join(dir, "equin@.service");
  writeFileSync(unitTemplate, "");
  if (opts.shipped !== null) {
    mkdirSync(join(dir, "releases", opts.shipped), { recursive: true });
    symlinkSync(join(dir, "releases", opts.shipped), install.currentLink);
  }
  const stub = (name: string, body: string) => {
    writeFileSync(
      join(bin, name),
      `${REMOTE_SCRIPT_SHEBANG}\necho "${name} $*" >> ${dir}/calls\n${body}\n`,
    );
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    "systemctl",
    `case "$1" in
  is-active) echo failed; exit 3 ;;
  restart) exit ${opts.restartFails === true ? 1 : 0} ;;
esac`,
  );
  stub("journalctl", "echo 'journal line'");
  writeFileSync(join(dir, "health"), opts.health ?? "");
  stub(
    "curl",
    `case "$*" in
  */api/health/ready*) exit 0 ;;
  *) cat ${dir}/health ;;
esac`,
  );
  // The unit template's path is fixed (`/etc/systemd/system/…`): point the
  // script at the case's own copy.
  const script = restartScript({ install, loopbackPort: 9100 }).replace(
    `UNIT_TEMPLATE='${UNIT_TEMPLATE_PATH}'`,
    `UNIT_TEMPLATE='${unitTemplate}'`,
  );
  const path = join(dir, "restart.sh");
  writeFileSync(path, script);

  const proc = Bun.spawn(["bash", path], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SETTLE_INTERVAL_SEC: "0.1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const calls = await Bun.file(join(dir, "calls"))
    .text()
    .catch((err: unknown) => {
      if ((err as { code?: string }).code === "ENOENT") return "";
      throw err;
    });
  return { code, stderr, calls };
}

const health = (runId: string, boot: string) =>
  JSON.stringify({ ok: true, startedAt: 1000, boot, runId });

test("the generated restart script parses", async () => {
  const path = join(tmp, "parse.sh");
  writeFileSync(
    path,
    restartScript({ install: deriveInstall("website"), loopbackPort: 9100 }),
  );
  const proc = Bun.spawn(["bash", "-n", path], { stderr: "pipe" });
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("the ssh deadline outlasts the whole health gate", () => {
  expect(RESTART_MS / 1000).toBeGreaterThan(
    READY_ATTEMPTS * READY_INTERVAL_SEC + SETTLE_DEADLINE_SEC,
  );
});

test("restarts the unit and passes once the release current names settles", async () => {
  const r = await runRestart({
    shipped: "run-7",
    health: health("run-7", "settled"),
  });
  expect(r.stderr).toContain(
    "[ok] equin@website.service is serving runId run-7",
  );
  expect(r.code).toBe(0);
  expect(r.calls).toContain("systemctl restart equin@website.service");
});

test("refuses, restarting nothing, when nothing was ever shipped", async () => {
  const r = await runRestart({ shipped: null });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("nothing has been shipped");
  expect(r.calls).not.toContain("systemctl restart");
});

test("fails with the journal when systemctl cannot restart the unit", async () => {
  const r = await runRestart({ shipped: "run-7", restartFails: true });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("systemctl restart equin@website.service failed");
  expect(r.stderr).toContain("journal line");
});

test("fails when another release answers than the one current names", async () => {
  const r = await runRestart({
    shipped: "run-7",
    health: health("run-6", "settled"),
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("does not report run-7");
});
