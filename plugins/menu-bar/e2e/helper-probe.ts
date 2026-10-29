/**
 * The runner both native-helper probes share (`bridge-probe.ts`,
 * `window-probe.ts`): builds this checkout's `equin-desktop` when its build is
 * missing or stale (`./equin deps install menu-bar-helper`), runs it in a
 * probe mode on this checkout's deploy, and reports each JSON row it prints
 * (`{ row, expected, held, detail }`) and its verdict.
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  report,
  targetNamespace,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { cargoBinary } from "@plugins/infra/plugins/deps/plugins/rust/deps";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { menuBarHelper } from "@plugins/menu-bar/deps";

const RowSchema = z.object({
  row: z.string(),
  expected: z.string(),
  held: z.boolean(),
  detail: z.string(),
});
const VerdictSchema = z.object({ verdict: z.string() }).passthrough();

/** Run `equin-desktop <mode> --namespace <this deploy's> …extra` and report it. */
export async function runHelperProbe(opts: {
  title: string;
  mode: string;
  extraArgs?: string[];
  notes?: (namespace: Namespace) => string[];
}): Promise<void> {
  const r = report(opts.title);
  const ready = await ensureDepViaCli(menuBarHelper, {
    stdio: "inherit",
    grant: null,
  });
  const binary = cargoBinary(ready);
  const namespace = targetNamespace();
  r.note(`helper ${binary}`);
  for (const note of opts.notes?.(namespace) ?? []) r.note(note);

  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      binary,
      [opts.mode, "--namespace", namespace, ...(opts.extraArgs ?? [])],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (c) => resolve({ code: c, stdout: out, stderr: err }));
  });

  const lines = stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);
  for (const line of lines) {
    const row = RowSchema.safeParse(line);
    if (row.success) {
      r.ok(
        `${row.data.row} — ${row.data.expected}`,
        row.data.held,
        row.data.detail,
      );
    }
  }
  const verdict = lines
    .map((l) => VerdictSchema.safeParse(l))
    .find((v) => v.success);
  r.eq(
    "verdict",
    verdict?.success ? verdict.data.verdict : "none printed",
    "held",
  );
  r.eq("probe exit code", code, 0);
  if (code !== 0) r.note(`helper stderr:\n${stderr}`);
  await r.finish();
}
