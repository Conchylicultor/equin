import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { sanitizeChannel } from "@plugins/infra/plugins/file-sink/core";
import { worktreeDataDir } from "@plugins/infra/plugins/paths/server";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";

/** Which stream a stored line was published on. */
export type LogStream = "stdout" | "stderr";

// The READ half of the persistent log-channel substrate. The WRITE/rotation half
// now lives in `@plugins/infra/plugins/file-sink` — durable channels back
// themselves with a `defineFileSink` (see `log.ts` / `client-ingress.ts`), which
// owns the bounded-append + rotation the agent reads back here with `tail`/`cat`.

// The read path takes an ARBITRARY caller-supplied name (an MCP argument, a
// report row), so this — the one place a name becomes a path — is its boundary.
export function logsDirFor(worktree: string): string {
  return join(worktreeDataDir(asNamespace(worktree)), "logs");
}

// Resolve THIS process's logs dir, from the runtime namespace it declared at its
// entry point. Throws loudly when nothing declared one — a durable sink with no
// worktree to write into is a bug, not a fallback. Shared by the write path
// (defineLogSink / the client ingress family) and unused by the read path (which
// takes an explicit worktree).
export function logsDir(): string {
  return join(worktreeDataDir(runtimeNamespace()), "logs");
}

// Max bytes a tail read pulls off disk via a positioned read, so even a full
// (≤128 MB) live file is never materialized whole into memory.
const READ_TAIL_BYTES = 8 * 1024 * 1024;

// Read path: resolves an ARBITRARY worktree's logs (the MCP handler runs in the
// launching backend, not the target worktree). The filesystem is shared, so
// reading another worktree's files just works — like query_db reaching any
// worktree DB.

export function listChannelsInDir(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // Rotated files (`channel.jsonl.N`) don't end in `.jsonl`, so they're excluded.
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => n.slice(0, -".jsonl".length));
}

export function listChannels(worktree: string): string[] {
  return listChannelsInDir(logsDirFor(worktree));
}

function tryParseEntry(
  line: string,
): { t: number; stream?: LogStream; line: string } | null {
  try {
    return JSON.parse(line);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

// Bounded tail read: pull at most the last READ_TAIL_BYTES off disk via a
// positioned read, so even a full (≤128 MB) live file is never materialized
// whole in memory. When we didn't start at offset 0 the first line is (probably)
// partial — drop it. Rotated history (`channel.jsonl.N`) is intentionally NOT
// stitched in: `tail` is a recent-lines request and rotated files are cold; the
// live file's tail is the contract.
export function readTail(
  file: string,
  tail: number,
): { t: number; stream?: LogStream; line: string }[] | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - READ_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buf, offset, length - offset, start + offset);
      if (read === 0) break;
      offset += read;
    }
    return parseTail(buf.toString("utf8", 0, offset), start > 0, tail);
  } finally {
    closeSync(fd);
  }
}

// Split a tail read into its envelope entries, the newest `tail` kept. A read
// that did not start at offset 0 begins mid-line, so its first line is dropped.
function parseTail(
  text: string,
  startedMidFile: boolean,
  tail: number,
): { t: number; stream?: LogStream; line: string }[] {
  if (startedMidFile) {
    const nl = text.indexOf("\n");
    text = nl === -1 ? "" : text.slice(nl + 1);
  }
  const entries: { t: number; stream?: LogStream; line: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parsed = tryParseEntry(line);
    // Tolerate corrupt/partial lines (e.g. a half-flushed append).
    if (parsed) entries.push(parsed);
  }
  return entries.slice(-tail);
}

// `readTail` without blocking the event loop: the same bounded positioned read,
// through `fs/promises`. For a caller on a hot async path (a live-resource
// loader re-reading many files), where a sync read would freeze every other
// loader, socket send and request for its whole duration.
export async function readTailAsync(
  file: string,
  tail: number,
): Promise<{ t: number; stream?: LogStream; line: string }[] | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - READ_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buf,
        offset,
        length - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return parseTail(buf.toString("utf8", 0, offset), start > 0, tail);
  } finally {
    await handle.close();
  }
}

export function readChannelEntries(
  worktree: string,
  channel: string,
  tail: number,
): { t: number; stream?: LogStream; line: string }[] | null {
  return readTail(channelFile(worktree, channel), tail);
}

function channelFile(worktree: string, channel: string): string {
  return join(logsDirFor(worktree), sanitizeChannel(channel) + ".jsonl");
}

// Read a channel whose payload lines are each a JSON object of type `T`: unwrap
// the log-channel envelope, tolerantly parse the inner JSON, and schema-drop the
// rest. The tolerant parse mirrors `readTail`'s envelope handling one level in — a
// torn tail line (a half-flushed append) is skipped; any other parse error is a
// real bug and rethrown. Invalid-shape lines (old schema, corrupt payload) are
// dropped via `safeParse`.
//
// A missing/empty channel collapses to `[]` — indistinguishable from a channel
// that exists but holds no valid lines. Callers that must tell "no channel yet"
// apart from "channel present but empty" should use `readChannelEntries` directly
// (it returns `null` for a missing file).
export function readChannelJson<T>(
  worktree: string,
  channel: string,
  tail: number,
  schema: ZodParser<T>,
): T[] {
  return parseJsonEntries(readChannelEntries(worktree, channel, tail), schema);
}

// `readChannelJson` without blocking the event loop (see `readTailAsync`).
export async function readChannelJsonAsync<T>(
  worktree: string,
  channel: string,
  tail: number,
  schema: ZodParser<T>,
): Promise<T[]> {
  return parseJsonEntries(
    await readTailAsync(channelFile(worktree, channel), tail),
    schema,
  );
}

function parseJsonEntries<T>(
  entries: { line: string }[] | null,
  schema: ZodParser<T>,
): T[] {
  if (!entries) return [];
  const out: T[] = [];
  for (const entry of entries) {
    let obj: unknown;
    try {
      obj = JSON.parse(entry.line);
    } catch (err) {
      // Tolerate a torn tail line; surface anything else.
      if (err instanceof SyntaxError) continue;
      throw err;
    }
    const parsed = schema.safeParse(obj);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
