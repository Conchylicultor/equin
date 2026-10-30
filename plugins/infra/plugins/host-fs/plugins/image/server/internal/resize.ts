import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { rename, stat, utimes, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  inertHeaders,
  openHostFile,
  resolveHostPath,
  type HostFileOpen,
} from "@plugins/infra/plugins/host-fs/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { parseEdge, resizedVersion, type ResizedEdge } from "../../core";
import { asUserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/** JPEG / WebP quality of a resized copy: invisible loss at thumbnail and screen sizes. */
const QUALITY = 82;
/** A hit touches its copy at most this often, so the sweep sees it used. */
const TOUCH_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Decoding a 30-megapixel JPEG takes ~150 ms of CPU. Only the backend whose
 * page is browsing images serves these, so the bound is per process: enough to
 * fill a grid quickly, not the whole box.
 */
const builds = createSemaphore(Math.max(2, Math.floor(cpus().length / 2)));
const inflight = createInflight();

type Opened = Extract<HostFileOpen, { kind: "ok" }>;

/** A copy in the cache: its file and its content type. */
type Copy = { file: string; type: "image/jpeg" | "image/webp" };

const EXT = { "image/jpeg": "jpg", "image/webp": "webp" } as const;

function cacheKey(file: Opened, edge: ResizedEdge): string {
  return createHash("sha256")
    .update(`${file.path}\0${resizedVersion(file)}\0${edge}`)
    .digest("hex");
}

function cached(dir: string, key: string): Copy | null {
  for (const type of ["image/jpeg", "image/webp"] as const) {
    const file = join(dir, `${key}.${EXT[type]}`);
    if (existsSync(file)) return { file, type };
  }
  return null;
}

/** Decode, rotate upright, shrink, encode — the whole of a resize. */
export async function resizeBytes(
  bytes: Uint8Array,
  edge: ResizedEdge,
): Promise<{ data: Buffer; type: Copy["type"] }> {
  const image = sharp(bytes, { failOn: "none" });
  const { hasAlpha } = await image.metadata();
  const pipeline = image.rotate().resize({
    width: edge,
    height: edge,
    fit: "inside",
    withoutEnlargement: true,
  });
  return hasAlpha
    ? {
        data: await pipeline.webp({ quality: QUALITY }).toBuffer(),
        type: "image/webp",
      }
    : {
        data: await pipeline.jpeg({ quality: QUALITY }).toBuffer(),
        type: "image/jpeg",
      };
}

/** Thrown when sharp cannot decode the bytes: the client falls back to the original. */
class UndecodableImageError extends Error {}

async function build(
  dir: string,
  file: Opened,
  edge: ResizedEdge,
  key: string,
): Promise<Copy> {
  const hit = cached(dir, key);
  if (hit) return hit;
  return builds.run(async () => {
    const bytes = await file.read();
    let out: Awaited<ReturnType<typeof resizeBytes>>;
    try {
      out = await resizeBytes(bytes, edge);
    } catch (err) {
      // sharp reports every decode failure as a plain Error; the read above
      // already succeeded, so an error here is the bytes, not the disk.
      if (err instanceof Error)
        throw new UndecodableImageError(`${file.path}: ${err.message}`);
      throw err;
    }
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${key}.${EXT[out.type]}`);
    const tmp = join(dir, `.tmp-${key}-${process.pid}`);
    await writeFile(tmp, out.data);
    await rename(tmp, target);
    return { file: target, type: out.type };
  });
}

async function touch(file: string): Promise<void> {
  const st = await stat(file);
  if (Date.now() - st.mtimeMs < TOUCH_EVERY_MS) return;
  const now = new Date();
  await utimes(file, now, now);
}

/**
 * `GET /api/host-fs/image/resized?path&edge&v` — a raw handler: the response is
 * image bytes with their own status and headers.
 */
export function makeResizedHandler(dir: () => string) {
  return async function handleResized(req: Request): Promise<Response> {
    const params = new URL(req.url, "http://localhost").searchParams;
    const raw = params.get("path");
    const edge = parseEdge(params.get("edge") ?? "");
    if (raw === null) return new Response("Missing path", { status: 400 });
    if (edge === null) return new Response("Bad edge", { status: 400 });
    let file: HostFileOpen;
    try {
      file = await openHostFile(resolveHostPath(raw));
    } catch (err) {
      if (err instanceof HttpError)
        return new Response(err.message, { status: err.status });
      throw err;
    }
    switch (file.kind) {
      case "missing":
        return new Response(`Not found: ${file.path}`, { status: 404 });
      case "denied":
        return new Response(`Permission denied: ${file.path}`, { status: 403 });
      case "not-a-file":
        return new Response(`Not a file: ${file.path}`, { status: 400 });
      case "unreadable-archive":
        return new Response(
          `Unreadable archive member (${file.reason}): ${file.path}`,
          { status: 422 },
        );
      case "ok":
        break;
    }
    const key = cacheKey(file, edge);
    let copy: Copy;
    try {
      copy = await inflight.run(key, () => build(dir(), file, edge, key));
    } catch (err) {
      if (err instanceof UndecodableImageError)
        return new Response(err.message, { status: 415 });
      throw err;
    }
    void runTracked("host-fs-image.touch", async () => {
      try {
        await touch(copy.file);
      } catch (err) {
        // The sweep may remove a copy between the serve and the touch.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    });
    // The URL names the version it wants; only a match is the same bytes forever.
    const current = params.get("v") === resizedVersion(file);
    return new Response(Bun.file(copy.file), {
      headers: {
        ...inertHeaders(asUserPath(file.path), copy.type),
        "Content-Type": copy.type,
        "Accept-Ranges": "none",
        "Cache-Control": current
          ? "private, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  };
}
