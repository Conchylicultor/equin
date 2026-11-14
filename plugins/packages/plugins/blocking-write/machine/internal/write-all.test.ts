import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The real scenario, cross-process: a child whose stdout is a pipe touches
// `process.stdout` (Bun turns the fd non-blocking), then writes far more than
// a pipe buffer holds synchronously while the parent does not read yet.
const MODULE = join(import.meta.dir, "write-all.ts");
const TOTAL = 4 * 1024 * 1024;

const CHILD = `
const { writeSync } = await import("node:fs");
const { writeAllSync } = await import(process.env.WA_MODULE);
void process.stdout;
const bytes = Buffer.alloc(${TOTAL});
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
if (process.env.WA_MODE === "bare") {
  let written = 0;
  while (written < bytes.length)
    written += writeSync(1, bytes, written, bytes.length - written);
} else {
  writeAllSync(1, bytes);
}
process.exit(0);
`;

async function run(mode: "bare" | "writeAll") {
  const proc = Bun.spawn([process.execPath, "-e", CHILD], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WA_MODULE: MODULE, WA_MODE: mode },
  });
  // A slow reader: the child fills the pipe before anything is drained.
  await Bun.sleep(300);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: new Uint8Array(out), err, code };
}

describe("writeAllSync", () => {
  test("a bare writeSync into a full non-blocking pipe throws EAGAIN (the bug)", async () => {
    const { err, code } = await run("bare");
    expect(code).not.toBe(0);
    expect(err).toContain("EAGAIN");
  });

  test("waits a full non-blocking pipe out and delivers every byte in order", async () => {
    const { out, err, code } = await run("writeAll");
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out.length).toBe(TOTAL);
    for (let i = 0; i < out.length; i += 4093) expect(out[i]).toBe(i % 251);
    expect(out[TOTAL - 1]).toBe((TOTAL - 1) % 251);
  });
});
