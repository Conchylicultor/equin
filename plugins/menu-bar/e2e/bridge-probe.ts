/**
 * The native bridge's trust boundary, probed on the real helper
 * (research/2026-10-28-menu-bar-native-edge-pin.md, Verification): this
 * checkout's `equin-desktop` runs `probe` on this checkout's deploy — the
 * tray's own panel window, runtime capability and command gate, on WebKit,
 * with no tray icon and nothing handed to the browser. The helper evaluates
 * an attacker script in the panel's main frame and judges each row of the
 * 2026-10-24 probe matrix:
 *
 *   main frame on the pin            answered (the one caller)
 *   srcdoc / same-origin sandboxed / opaque frames → top.equinNative, the raw IPC
 *   same-origin URL frame, <object>, <embed>, another namespace's frame
 *   pushState to another route, then back
 *   window.open                      no window; handed to the browser
 *   location.assign elsewhere        the panel stays on the pin
 *
 * Every row but the first must be denied. Builds the helper first when this
 * checkout's build of it is missing or stale (`./equin deps install
 * menu-bar-helper`).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/menu-bar/e2e/bridge-probe.ts
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  report,
  targetNamespace,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { namespaceUrl } from "@plugins/infra/plugins/namespace/core";
import { cargoBinary } from "@plugins/infra/plugins/deps/plugins/rust/deps";
import { menuBarHelper } from "@plugins/menu-bar/deps";

const RowSchema = z.object({
  row: z.string(),
  expected: z.string(),
  held: z.boolean(),
  detail: z.string(),
});
const VerdictSchema = z.object({ verdict: z.string() }).passthrough();

const r = report("menu-bar: native bridge probe");

const ready = await ensureDepViaCli(menuBarHelper, {
  stdio: "inherit",
  grant: null,
});
const binary = cargoBinary(ready);
const namespace = targetNamespace();
r.note(`helper ${binary}`);
r.note(`panel on ${namespaceUrl(namespace, "/home/menu-bar")}`);

const { code, stdout, stderr } = await new Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}>((resolve, reject) => {
  const child = spawn(binary, ["probe", "--namespace", namespace], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
