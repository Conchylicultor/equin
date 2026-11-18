import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { countRacyEntries, readIndexFsmonitorToken } from "../../core";

// A throwaway repository's real index, with extensions git wrote (TREE).
let repo: string;
let index: Uint8Array;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "fsmn-token-test-"));
  const git = async (...args: string[]) => {
    const r = await spawnCaptured([GIT, "-C", repo, ...args], {
      timeoutMs: 60_000,
    });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  await git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "a");
  writeFileSync(join(repo, "b.txt"), "b");
  await git("add", ".");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c");
  index = new Uint8Array(readFileSync(join(repo, ".git", "index")));
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** `bytes` with one extension spliced in before the 20-byte trailer. */
function withExtension(bytes: Uint8Array, sig: string, data: Uint8Array) {
  const at = bytes.byteLength - 20;
  const ext = new Uint8Array(8 + data.byteLength);
  ext.set(new TextEncoder().encode(sig), 0);
  new DataView(ext.buffer).setUint32(4, data.byteLength);
  ext.set(data, 8);
  const out = new Uint8Array(bytes.byteLength + ext.byteLength);
  out.set(bytes.subarray(0, at), 0);
  out.set(ext, at);
  out.set(bytes.subarray(at), at + ext.byteLength);
  return out;
}

function fsmnV2(token: string): Uint8Array {
  const t = new TextEncoder().encode(token);
  // version, token + NUL, then the (here empty-sized) ewah bitmap length.
  const data = new Uint8Array(4 + t.byteLength + 1 + 4);
  new DataView(data.buffer).setUint32(0, 2);
  data.set(t, 4);
  return data;
}

test("an index git wrote without fsmonitor carries no token", () => {
  expect(readIndexFsmonitorToken(index)).toBeNull();
});

test("the FSMN token is read past the entries and the other extensions", () => {
  const token = "builtin:0.50938.20261118T105943.262417Z:0";
  const bytes = withExtension(index, "FSMN", fsmnV2(token));
  expect(readIndexFsmonitorToken(bytes)).toBe(token);
  // The entries are read the same with the extension there.
  expect(countRacyEntries(bytes, 0).entries).toBe(2);
});

test("a hook's version-1 token is its timestamp", () => {
  const data = new Uint8Array(12 + 4);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1);
  view.setBigUint64(4, 1731923983000000000n);
  expect(readIndexFsmonitorToken(withExtension(index, "FSMN", data))).toBe(
    "v1:1731923983000000000",
  );
});

test("an extension overrunning the file throws, never answers", () => {
  const bad = withExtension(index, "FSMN", fsmnV2("builtin:0.1.x:0"));
  const at = bad.byteLength - 20 - (8 + fsmnV2("builtin:0.1.x:0").byteLength);
  new DataView(bad.buffer).setUint32(at + 4, 1_000_000);
  expect(() => readIndexFsmonitorToken(bad)).toThrow(/overruns/);
});
