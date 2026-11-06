import { rename, writeFile } from "node:fs/promises";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { createReadStream } from "node:fs";
import { createGunzip, gunzipSync, gzipSync } from "node:zlib";
import { JSONParser } from "@streamparser/json";
import { z } from "zod";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { chordDir } from "@plugins/apps/plugins/chord/data-dirs";
import { ensureDep, readyNow } from "@plugins/infra/plugins/deps/deps";
import { downloadedFile } from "@plugins/infra/plugins/deps/plugins/download/deps";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { HookpadHarmonyDocSchema } from "@plugins/integrations/plugins/hooktheory/core";
import {
  SheetSageAlignmentSchema,
  SnapshotLineSchema,
  type IndexLoadPhase,
  type SnapshotLine,
  type SnapshotSkipReason,
  SNAPSHOT_FORMAT_VERSION,
} from "../../core";
import { SHEETSAGE_DUMP_FILES, sheetSageDumps } from "../../deps";

// ── The compact source snapshot: build once per machine, read on every load ──

/** The song index's area of the app dir. The snapshot is the copy backups keep. */
export const songIndexArea = chordDir.subdir("song-index");

/**
 * The snapshot's name: both dump pins and the line format, so a different dump
 * or a new format is a different file rather than a misread one.
 */
export const SNAPSHOT_NAME = `sheetsage-${SHEETSAGE_DUMP_FILES.processed.sha256.slice(0, 12)}-${SHEETSAGE_DUMP_FILES.raw.sha256.slice(0, 12)}-v${SNAPSHOT_FORMAT_VERSION}`;

export function snapshotPath(): AppPath {
  return songIndexArea.file(`${SNAPSHOT_NAME}.ndjson.gz`);
}

/** How long to wait between two tries for the build lock while another process builds. */
const LOCK_RETRY_MS = 1_000;

export type SnapshotHooks = {
  log: (line: string) => void;
  /** The supervised run's exec context: what installs the dump files when they are missing. */
  exec: ExecContext;
  /** Called as the work moves to downloading or building. */
  onPhase: (phase: IndexLoadPhase) => Promise<void>;
};

/**
 * The snapshot's path, built first when it is missing.
 *
 * The dump files come from the `sheetsage-dumps` dependency (installed here
 * when missing, under infra/deps' own lock); they are read only to build.
 *
 * Under a host-wide flock on a file in the app's own dir, so two backends opening
 * the app at once build it once: the second waits, then finds the file. The
 * kernel releases the lock when its holder dies, so a killed build never wedges
 * the next one. (`flockTry` is non-blocking by design — a blocking `flock` would
 * freeze the event loop — so the wait re-tries it, as the build lock does.)
 */
export async function ensureSnapshot(hooks: SnapshotHooks): Promise<AppPath> {
  const path = snapshotPath();
  if (await exists(path)) return path;

  songIndexArea.ensure();
  const lock = openOwnedFd(songIndexArea.file("snapshot.lock"), "a");
  try {
    if (!flockTry(lock.fd)) {
      hooks.log("another process is building the snapshot; waiting for it");
      await hooks.onPhase("building-snapshot");
      while (!flockTry(lock.fd)) await Bun.sleep(LOCK_RETRY_MS);
    }
    if (await exists(path)) return path;

    if ((await readyNow(sheetSageDumps)).kind !== "ready") {
      await hooks.onPhase("downloading");
    }
    const dumps = await ensureDep(sheetSageDumps, hooks.exec, {
      log: hooks.log,
    });
    const processedPath = downloadedFile(
      dumps,
      SHEETSAGE_DUMP_FILES.processed.name,
    );
    const rawPath = downloadedFile(dumps, SHEETSAGE_DUMP_FILES.raw.name);

    await hooks.onPhase("building-snapshot");
    const report = await buildSnapshot({
      processedPath,
      rawPath,
      outPath: path,
      log: hooks.log,
    });
    hooks.log(
      `snapshot ${path}: ${report.sections} sections, ${report.skipped} skipped, ${(report.bytes / 1e6).toFixed(1)} MB, ${Math.round(report.ms / 1000)} s`,
    );
    return path;
  } finally {
    lock.close();
  }
}

// ── Building ─────────────────────────────────────────────────────────────────

/** What the snapshot reads of a processed section. Everything else is stripped. */
const ProcessedSectionSchema = z.object({
  tags: z.array(z.string()),
  hooktheory: z.object({ artist: z.string(), song: z.string() }),
  youtube: z.object({ duration: z.number().nullable() }),
  alignment: SheetSageAlignmentSchema,
});
type ProcessedSection = z.infer<typeof ProcessedSectionSchema>;

/**
 * What the snapshot reads of a raw entry: the document (checked by the harmony
 * schema below, not here, so a refused one is a counted skip) and the API
 * record's display names. The melody, `xmlData` and the editor state are
 * dropped by parsing.
 */
const RawEntrySchema = z.object({
  json: z.unknown(),
  json_api: z
    .object({ artist: z.string(), song: z.string(), section: z.string() })
    .nullable()
    .optional(),
});

export type SnapshotBuildReport = {
  sections: number;
  skipped: number;
  skippedByReason: Partial<Record<SnapshotSkipReason, number>>;
  bytes: number;
  ms: number;
};

/**
 * Stream both dump files into the snapshot: one line per raw entry (a section
 * or a skip with its reason), then a skip for every processed section the raw
 * file lacks. Written gzipped to a temp name and renamed, so a reader never
 * sees a partial snapshot.
 *
 * The processed file is one JSON.parse (309 MB). The raw file is 1.5 GB — past
 * the longest string a runtime holds — so it is streamed one entry at a time.
 */
export async function buildSnapshot(args: {
  processedPath: AppPath;
  rawPath: AppPath;
  outPath: AppPath;
  log: (line: string) => void;
}): Promise<SnapshotBuildReport> {
  const started = Date.now();
  const processed = z
    .record(z.string(), ProcessedSectionSchema)
    .parse(
      JSON.parse(
        gunzipSync(await readFile(args.processedPath)).toString("utf8"),
      ),
    );
  const unpaired = new Set(Object.keys(processed));
  args.log(`processed file: ${unpaired.size} sections`);

  const lines: string[] = [];
  const skippedByReason: Partial<Record<SnapshotSkipReason, number>> = {};
  let sections = 0;
  const write = (line: SnapshotLine) => {
    // Parsed on the way out: a line the loader would refuse fails here, at the writer.
    lines.push(JSON.stringify(SnapshotLineSchema.parse(line)));
    if (line.kind === "section") sections++;
    else skippedByReason[line.reason] = (skippedByReason[line.reason] ?? 0) + 1;
  };

  let entries = 0;
  const parser = new JSONParser({ paths: ["$.*"], keepStack: false });
  parser.onValue = ({ key, value }) => {
    if (typeof key !== "string") {
      throw new Error(
        `raw file: top-level key ${String(key)} is not a section id`,
      );
    }
    entries++;
    unpaired.delete(key);
    write(snapshotLine(key, RawEntrySchema.parse(value), processed[key]));
    if (entries % 5000 === 0) {
      args.log(
        `… ${entries} raw entries, ${Math.round((Date.now() - started) / 1000)} s`,
      );
    }
  };
  for await (const chunk of createReadStream(args.rawPath).pipe(
    createGunzip(),
  )) {
    parser.write(chunk as Buffer);
  }
  for (const id of unpaired) {
    const p = processed[id];
    write({
      kind: "skipped",
      id,
      reason: "no-raw-entry",
      detail: "the processed file has this section, the raw file does not",
      artistSlug: p?.hooktheory.artist ?? null,
      songSlug: p?.hooktheory.song ?? null,
    });
  }

  const gz = gzipSync(`${lines.join("\n")}\n`);
  const tmp = `${args.outPath}.tmp-${process.pid}`;
  songIndexArea.ensure();
  await writeFile(tmp, gz);
  await rename(tmp, args.outPath);
  const skipped = lines.length - sections;
  return {
    sections,
    skipped,
    skippedByReason,
    bytes: gz.byteLength,
    ms: Date.now() - started,
  };
}

/** The snapshot line for one raw entry. */
export function snapshotLine(
  id: string,
  raw: z.infer<typeof RawEntrySchema>,
  processed: ProcessedSection | undefined,
): SnapshotLine {
  const skip = (reason: SnapshotSkipReason, detail: string): SnapshotLine => ({
    kind: "skipped",
    id,
    reason,
    detail,
    artistSlug: processed?.hooktheory.artist ?? null,
    songSlug: processed?.hooktheory.song ?? null,
  });
  if (raw.json === null || raw.json === undefined) {
    return skip("no-document", "the raw entry holds no Hookpad document");
  }
  if (processed === undefined) {
    return skip(
      "no-processed-section",
      "the processed file lacks this section",
    );
  }
  if (raw.json_api === null || raw.json_api === undefined) {
    return skip(
      "no-display-names",
      "the raw entry has no API record (artist, song, section name)",
    );
  }
  const doc = HookpadHarmonyDocSchema.safeParse(raw.json);
  if (!doc.success) {
    return skip(
      "document-refused",
      doc.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  return {
    kind: "section",
    id,
    artist: raw.json_api.artist,
    song: raw.json_api.song,
    sectionName: raw.json_api.section,
    artistSlug: processed.hooktheory.artist,
    songSlug: processed.hooktheory.song,
    youtube: {
      ...doc.data.youtube,
      durationSeconds: processed.youtube.duration,
    },
    chords: doc.data.chords,
    keys: doc.data.keys,
    meters: doc.data.meters,
    tempos: doc.data.tempos,
    endBeat: doc.data.endBeat,
    alignment: processed.alignment,
    tags: processed.tags,
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The file's non-empty lines with their numbers, gunzipped in one go (8.7 MB → 115 MB). */
async function* snapshotTextLines(
  path: AppPath,
): AsyncGenerator<{ lineNo: number; text: string }> {
  const text = gunzipSync(await readFile(path)).toString("utf8");
  let lineNo = 0;
  for (const line of text.split("\n")) {
    lineNo++;
    if (line === "") continue;
    yield { lineNo, text: line };
  }
}

function lineError(
  path: string,
  lineNo: number,
  error: z.ZodError,
  what: string,
): Error {
  return new Error(
    `${path} line ${lineNo} is not ${what}: ${error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`,
  );
}

/**
 * Every line of a snapshot, parsed. The whole file is small (8.7 MB gzipped),
 * so it is read in one go; a line that does not parse throws naming its number.
 */
export async function* readSnapshot(
  path: AppPath,
): AsyncGenerator<SnapshotLine> {
  for await (const { lineNo, text } of snapshotTextLines(path)) {
    const parsed = SnapshotLineSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      throw lineError(path, lineNo, parsed.error, "a snapshot line");
    yield parsed.data;
  }
}

/**
 * Just the fields that place a line: what it is, and which songs a scope keeps.
 *
 * Deliberately shallow. This is what a load counts its total with, and the full
 * `SnapshotLineSchema` walks every field of every Hookpad chord — decoding the
 * whole 115 MB snapshot a second time to learn a number the shape of the load
 * already implies. Four fields cost a JSON.parse and nothing else, so the
 * expensive decode happens exactly once, on the pass that inserts.
 */
const SnapshotHeadSchema = z.object({
  kind: z.enum(["section", "skipped"]),
  id: z.string(),
  artistSlug: z.string().nullable(),
  songSlug: z.string().nullable(),
});
export type SnapshotHead = z.infer<typeof SnapshotHeadSchema>;

/** Every line's head, in file order. Agrees with `readSnapshot` line for line. */
export async function* readSnapshotHeads(
  path: AppPath,
): AsyncGenerator<SnapshotHead> {
  for await (const { lineNo, text } of snapshotTextLines(path)) {
    const parsed = SnapshotHeadSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw lineError(path, lineNo, parsed.error, "a snapshot line head");
    }
    yield parsed.data;
  }
}
