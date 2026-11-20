import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadToDrive, type DriveUploadDeps } from "./upload";

const KIB256 = 256 * 1024;
const SESSION = "https://upload.test/session/1";

/**
 * An in-memory Drive resumable session. A PUT can be cut off mid-body: the
 * fake keeps the bytes that "arrived" (rounded down to 256 KiB, as Drive
 * persists) and the client sees the fetch reject the way Bun does on a reset.
 */
function fakeDrive(total: number) {
  const stored = new Uint8Array(total); // what Drive holds, by offset
  let confirmed = 0;
  const plan: Array<"ok" | { resetAfter: number } | { status: number }> = [];
  const log: string[] = [];
  const state = { stuck: false };

  function rangeResponse(): Response {
    if (confirmed === total) {
      const body = { id: "file-1", webViewLink: "https://drive/file-1" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const headers: Record<string, string> =
      confirmed === 0 ? {} : { Range: `bytes=0-${confirmed - 1}` };
    return new Response(null, { status: 308, headers });
  }

  const fetchImpl: DriveUploadDeps["fetch"] = async (url, init) => {
    const headers = new Headers(init.headers);
    if (init.method === "POST") {
      log.push("init");
      return new Response(null, {
        status: 200,
        headers: { Location: SESSION },
      });
    }
    expect(url).toBe(SESSION);
    const range = headers.get("Content-Range") ?? "";
    if (range.startsWith("bytes */")) {
      log.push(`query → ${confirmed}`);
      return rangeResponse();
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m) throw new Error(`bad Content-Range ${range}`);
    const start = Number(m[1]);
    const end = Number(m[2]) + 1;
    // Drive rejects a chunk that does not start at its confirmed offset.
    expect(start).toBe(confirmed);
    const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
    expect(bytes.length).toBe(end - start);
    if (state.stuck) {
      log.push(`put ${start}-${end} → 308, nothing kept`);
      return rangeResponse();
    }
    const step = plan.shift() ?? "ok";
    if (step !== "ok" && "status" in step) {
      log.push(`put ${start}-${end} → ${step.status}`);
      return new Response("backend error", { status: step.status });
    }
    if (step !== "ok") {
      const kept =
        Math.floor(Math.min(step.resetAfter, bytes.length - 1) / KIB256) *
        KIB256;
      stored.set(bytes.subarray(0, kept), start);
      confirmed = start + kept;
      log.push(`put ${start}-${end} → reset at ${start + step.resetAfter}`);
      const err = new Error("The socket connection was closed unexpectedly.");
      (err as Error & { code: string }).code = "ECONNRESET";
      throw err;
    }
    stored.set(bytes, start);
    confirmed = end;
    log.push(`put ${start}-${end} → ${confirmed === total ? "done" : 308}`);
    return rangeResponse();
  };

  return {
    fetchImpl,
    plan,
    log,
    state,
    received: () => stored.subarray(0, confirmed),
  };
}

let dir: string;
let archive: string;
const SIZE = KIB256 * 10 + 1234; // not chunk-aligned: the final chunk is short
const content = Uint8Array.from({ length: SIZE }, (_, i) => (i * 31) % 251);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "drive-upload-test-"));
  archive = join(dir, "archive.tar.gz");
  await writeFile(archive, content);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(fetchImpl: DriveUploadDeps["fetch"], sleeps: number[]) {
  return {
    fetch: fetchImpl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    chunkBytes: KIB256 * 4,
    maxStalls: 3,
    maxFailures: 12,
    requestTimeoutMs: 60_000,
  };
}

describe("uploadToDrive", () => {
  test("uploads in chunks with no failure", async () => {
    const drive = fakeDrive(SIZE);
    const sleeps: number[] = [];
    const res = await uploadToDrive(
      archive,
      "folder",
      "a.tar.gz",
      "tok",
      deps(drive.fetchImpl, sleeps),
    );
    expect(res).toEqual({
      fileId: "file-1",
      webViewLink: "https://drive/file-1",
      recovered: 0,
    });
    expect(drive.received()).toEqual(content);
    expect(sleeps).toEqual([]);
  });

  test("a reset mid-chunk resumes from the last byte Drive confirmed", async () => {
    const drive = fakeDrive(SIZE);
    // Second chunk dies 1.5 × 256 KiB in: Drive keeps 256 KiB of it.
    drive.plan.push("ok", { resetAfter: KIB256 * 1.5 });
    const sleeps: number[] = [];
    const res = await uploadToDrive(
      archive,
      "folder",
      "a.tar.gz",
      "tok",
      deps(drive.fetchImpl, sleeps),
    );
    expect(res.recovered).toBe(1);
    expect(drive.received()).toEqual(content);
    expect(drive.log).toEqual([
      "init",
      `put 0-${KIB256 * 4} → 308`,
      `put ${KIB256 * 4}-${KIB256 * 8} → reset at ${KIB256 * 5.5}`,
      `query → ${KIB256 * 5}`,
      // Only what Drive did not confirm is sent again.
      `put ${KIB256 * 5}-${KIB256 * 9} → 308`,
      `put ${KIB256 * 9}-${SIZE} → done`,
    ]);
    expect(sleeps.length).toBe(1);
  });

  test("a 5xx is retried after a status query", async () => {
    const drive = fakeDrive(SIZE);
    drive.plan.push({ status: 503 });
    const res = await uploadToDrive(
      archive,
      "folder",
      "a.tar.gz",
      "tok",
      deps(drive.fetchImpl, []),
    );
    expect(res.recovered).toBe(1);
    expect(drive.received()).toEqual(content);
  });

  test("progress between failures resets the stall count", async () => {
    const drive = fakeDrive(SIZE);
    // Ten PUTs in a row reset after 256 KiB landed: ten failures, well above
    // maxStalls (3), but every one of them made progress.
    for (let i = 0; i < 10; i++) drive.plan.push({ resetAfter: KIB256 });
    const res = await uploadToDrive(
      archive,
      "folder",
      "a.tar.gz",
      "tok",
      deps(drive.fetchImpl, []),
    );
    expect(res.recovered).toBe(10);
    expect(drive.received()).toEqual(content);
  });

  test("gives up loudly after maxStalls failures with no progress", async () => {
    const drive = fakeDrive(SIZE);
    for (let i = 0; i < 10; i++) drive.plan.push({ resetAfter: 0 });
    const sleeps: number[] = [];
    expect(
      uploadToDrive(
        archive,
        "folder",
        "a.tar.gz",
        "tok",
        deps(drive.fetchImpl, sleeps),
      ),
    ).rejects.toThrow(
      /gave up after 4 failures in a row with no progress, at 0 of \d+ bytes confirmed; last error: The socket connection was closed unexpectedly/,
    );
  });

  test("gives up after maxFailures even when every failure made progress", async () => {
    const drive = fakeDrive(SIZE);
    // Every PUT resets after landing 256 KiB: each failure moves the upload,
    // so the stall count never trips — only the total cap stops it.
    for (let i = 0; i < 20; i++) drive.plan.push({ resetAfter: KIB256 });
    expect(
      uploadToDrive(archive, "folder", "a.tar.gz", "tok", {
        ...deps(drive.fetchImpl, []),
        maxFailures: 5,
      }),
    ).rejects.toThrow(
      /gave up after 6 failures in total, at \d+ of \d+ bytes confirmed/,
    );
  });

  test("a chunk answered 308 with no new bytes is a stall, not an endless loop", async () => {
    const drive = fakeDrive(SIZE);
    drive.state.stuck = true;
    expect(
      uploadToDrive(
        archive,
        "folder",
        "a.tar.gz",
        "tok",
        deps(drive.fetchImpl, []),
      ),
    ).rejects.toThrow(
      /gave up after 4 failures in a row with no progress, at 0 of/,
    );
  });

  test("a refused session (404) fails at once, without retrying", async () => {
    const drive = fakeDrive(SIZE);
    drive.plan.push({ status: 404 });
    const sleeps: number[] = [];
    expect(
      uploadToDrive(
        archive,
        "folder",
        "a.tar.gz",
        "tok",
        deps(drive.fetchImpl, sleeps),
      ),
    ).rejects.toThrow(/Drive upload: 404/);
    expect(sleeps).toEqual([]);
  });
});
