import { stat } from "@plugins/packages/plugins/timed-fs/core";
import { exponential } from "@plugins/packages/plugins/retry/core";

/**
 * Upload one archive to Drive with Google's RESUMABLE upload protocol, for
 * real: the bytes go up in chunks, and a chunk that dies on the network is
 * followed by a status query asking Drive how far it got, then the upload
 * continues from the last byte Drive confirmed.
 *
 * Before 2026-11-20 this opened a resumable session and then sent the whole
 * archive (~1 GB) as ONE streamed PUT. A connection reset fifteen minutes into
 * it (report-1794884443-cyv4ww) threw away everything sent so far and failed
 * the target, so the night's archive had no off-site copy. A reset from a
 * network peer is not ours to prevent; what is ours is that it costs one chunk
 * and a status query, not the night.
 *
 * Retries are BOUNDED twice over, and the give-up is loud (how far it got,
 * the last error): more than `maxStalls` failures in a row with no new byte
 * confirmed, or more than `maxFailures` failures in the whole upload, however
 * much each one moved. A request that hangs (a half-open connection never
 * rejects) is cut at `requestTimeoutMs` and counts as a failure. Drive
 * refusing the session itself (4xx other than 408/429, e.g. 404 for an
 * expired session) is not transient and fails at once.
 */

/** 64 MiB: a multiple of 256 KiB, as Drive requires for every non-final chunk. */
export const DRIVE_CHUNK_BYTES = 256 * 1024 * 256;

export interface DriveUploadDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** Bytes per PUT; a multiple of 256 KiB. */
  chunkBytes: number;
  /** Consecutive failures without new confirmed bytes tolerated. */
  maxStalls: number;
  /** Failures tolerated over the whole upload. */
  maxFailures: number;
  /** Deadline of one request (a chunk PUT or a status query). */
  requestTimeoutMs: number;
}

const defaultDeps: DriveUploadDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  chunkBytes: DRIVE_CHUNK_BYTES,
  maxStalls: 6,
  maxFailures: 30,
  // A 64 MiB chunk at 1 Mbit/s is ~9 min; a healthy night moves the whole
  // ~1 GB archive in about a minute.
  requestTimeoutMs: 15 * 60_000,
};

/** 2 s, 4 s, 8 s … capped at 60 s: ~2 min of waiting across a full stall run. */
const stallDelay = exponential({ initial: 2_000, max: 60_000 });

export interface DriveUploadResult {
  fileId: string;
  webViewLink: string;
  /** Failures the upload survived (resets, 5xx), for the run's detail. */
  recovered: number;
}

export async function uploadToDrive(
  archivePath: string,
  folderId: string,
  filename: string,
  accessToken: string,
  overrides: Partial<DriveUploadDeps> = {},
): Promise<DriveUploadResult> {
  const deps: DriveUploadDeps = { ...defaultDeps, ...overrides };
  if (deps.chunkBytes <= 0 || deps.chunkBytes % (256 * 1024) !== 0) {
    throw new Error(
      `Drive upload: chunkBytes ${deps.chunkBytes} is not a positive multiple of 256 KiB`,
    );
  }
  const total = (await stat(archivePath)).size;
  const file = Bun.file(archivePath);

  const uploadUrl = await openSession(
    deps,
    folderId,
    filename,
    accessToken,
    total,
  );

  let offset = 0;
  let stalls = 0;
  let recovered = 0;
  let confirmedAtLastFailure = -1;
  // After any failure, ask Drive before sending again: the failed PUT may
  // have landed some (or all) of its bytes.
  let mustQuery = false;

  for (;;) {
    // Only the request itself is caught: a rejected fetch is the network (a
    // reset, a DNS blip, a dropped link). Reading the reply is outside the
    // try, so a reply we cannot make sense of fails instead of being retried.
    let res: Response | undefined;
    let networkError = "";
    try {
      res = mustQuery
        ? await queryStatus(deps, uploadUrl, total)
        : await putChunk(deps, uploadUrl, file, offset, total);
    } catch (err) {
      networkError = err instanceof Error ? err.message : String(err);
    }
    let step: Step =
      res === undefined
        ? { kind: "transient", error: networkError }
        : await readStep(res, total);
    // A chunk PUT answered 308 without moving past where it started is a
    // failure, not progress: re-sending at once would loop with no bound.
    // (A status query may legitimately repeat the offset.)
    if (!mustQuery && step.kind === "progress" && step.confirmed <= offset) {
      step = {
        kind: "transient",
        error: `Drive confirmed ${step.confirmed} bytes after a chunk sent from ${offset}`,
      };
    }

    if (step.kind === "done") {
      return { fileId: step.id, webViewLink: step.webViewLink, recovered };
    }
    if (step.kind === "progress") {
      offset = step.confirmed;
      mustQuery = false;
      continue;
    }

    recovered++;
    mustQuery = true;
    stalls = offset > confirmedAtLastFailure ? 1 : stalls + 1;
    confirmedAtLastFailure = offset;
    if (stalls > deps.maxStalls || recovered > deps.maxFailures) {
      const why =
        stalls > deps.maxStalls
          ? `${stalls} failures in a row with no progress`
          : `${recovered} failures in total`;
      throw new Error(
        `Drive upload: gave up after ${why}, at ${offset} of ${total} bytes ` +
          `confirmed; last error: ${step.error}`,
      );
    }
    await deps.sleep(stallDelay(stalls - 1));
  }
}

type Step =
  | { kind: "done"; id: string; webViewLink: string }
  | { kind: "progress"; confirmed: number }
  | { kind: "transient"; error: string };

async function openSession(
  deps: DriveUploadDeps,
  folderId: string,
  filename: string,
  accessToken: string,
  total: number,
): Promise<string> {
  const initRes = await deps.fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "application/gzip",
        "X-Upload-Content-Length": String(total),
      },
      body: JSON.stringify({ name: filename, parents: [folderId] }),
    },
  );
  if (!initRes.ok) {
    throw new Error(
      `Drive upload init: ${initRes.status} ${await initRes.text()}`,
    );
  }
  await initRes.body?.cancel();
  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) {
    throw new Error("Drive upload init: missing Location header");
  }
  return uploadUrl;
}

async function putChunk(
  deps: DriveUploadDeps,
  uploadUrl: string,
  file: Blob,
  offset: number,
  total: number,
): Promise<Response> {
  const end = Math.min(offset + deps.chunkBytes, total);
  return deps.fetch(uploadUrl, {
    method: "PUT",
    signal: AbortSignal.timeout(deps.requestTimeoutMs),
    headers: {
      "Content-Length": String(end - offset),
      "Content-Range":
        total === 0 ? "bytes */0" : `bytes ${offset}-${end - 1}/${total}`,
    },
    body: file.slice(offset, end),
  });
}

/** Ask Drive how many bytes of the session it holds (an empty PUT). */
async function queryStatus(
  deps: DriveUploadDeps,
  uploadUrl: string,
  total: number,
): Promise<Response> {
  return deps.fetch(uploadUrl, {
    method: "PUT",
    signal: AbortSignal.timeout(deps.requestTimeoutMs),
    headers: { "Content-Length": "0", "Content-Range": `bytes */${total}` },
  });
}

async function readStep(res: Response, total: number): Promise<Step> {
  if (res.status === 200 || res.status === 201) {
    const body = (await res.json()) as { id?: unknown; webViewLink?: unknown };
    if (typeof body.id !== "string" || typeof body.webViewLink !== "string") {
      throw new Error(
        `Drive upload: completed but the response lacks id/webViewLink: ${JSON.stringify(body)}`,
      );
    }
    return { kind: "done", id: body.id, webViewLink: body.webViewLink };
  }
  if (res.status === 308) {
    // "Resume Incomplete": Range is `bytes=0-<last>`, absent when nothing
    // has been received yet.
    await res.body?.cancel();
    const range = res.headers.get("Range");
    if (range === null) return { kind: "progress", confirmed: 0 };
    const match = /^bytes=0-(\d+)$/.exec(range);
    if (!match) {
      throw new Error(`Drive upload: unreadable Range header "${range}"`);
    }
    const confirmed = Number(match[1]) + 1;
    if (confirmed > total) {
      throw new Error(
        `Drive upload: Drive confirms ${confirmed} bytes of a ${total}-byte file`,
      );
    }
    return { kind: "progress", confirmed };
  }
  const text = await res.text();
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    return { kind: "transient", error: `${res.status} ${text}` };
  }
  throw new Error(`Drive upload: ${res.status} ${text}`);
}
