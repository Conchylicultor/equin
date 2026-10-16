// The two drivers over the changed set: one that WRITES (build,
// `./singularity format`) and one that never does (the `format-clean` check).
// Both read the same set from `changed-files.ts` and decide the bytes through
// the same `formatInScope` over the same `formatSource`, so they cannot
// disagree about what "formatted" means.

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import { listChangedFormattableFiles } from "./changed-files";
import {
  findDirectiveDisplacements,
  formatDirectiveDisplacementReport,
  type DirectiveDisplacement,
} from "./directive-displacement";
import { formatOffThread } from "./format-thread";
import { formatInScope, type ChangedFile } from "./line-scope";
import { formatSource, type SourceBytes } from "./prettier";

/**
 * Read → format in scope → compare. NEVER writes. Returns the paths (relative
 * to `root`) of the `changed` files whose on-disk bytes are not what
 * `formatInScope` makes of them.
 *
 * `changed` must already be formattable — pass {@link listChangedFormattableFiles}
 * output, which is filtered by `isFormattable`. A held-out path THROWS out of
 * `formatSource` rather than being silently reported as already-formatted.
 */
export async function findUnformatted(
  root: string,
  changed: ChangedFile[],
): Promise<string[]> {
  const sources = await readSources(root, changed);
  const expected = await scopedOffThread(sources);
  return sources
    .filter((source, i) => expected[i] !== source.content)
    .map((source) => source.file);
}

type ScopedSource = SourceBytes & Pick<ChangedFile, "scope">;

/** Each of `changed` (relative to `root`) with its current bytes. */
async function readSources(
  root: string,
  changed: ChangedFile[],
): Promise<ScopedSource[]> {
  // One at a time: a branch's first build can change hundreds of files, and a
  // raw `readFile` per file all at once would open them all together.
  const sources: ScopedSource[] = [];
  for (const { file, scope } of changed) {
    sources.push({
      file,
      scope,
      content: await readFile(join(root, file), "utf8"),
    });
  }
  return sources;
}

/**
 * `formatInScope` for each source, formatting on the format thread
 * (`./format-thread`): prettier's load and its parse + print of one file are
 * each one synchronous run that no yield can split, and the readers run inside
 * a check pass whose checks share one thread. The first round is sent as one
 * batch; the thread remembers it, so each file's own first round is free.
 */
async function scopedOffThread(sources: ScopedSource[]): Promise<string[]> {
  await formatOffThread(
    sources.map(({ file, content }) => ({ file, content })),
  );
  const slice = createTimeSlicer();
  const out: string[] = [];
  for (const { file, content, scope } of sources) {
    await slice();
    out.push(
      await formatInScope({
        file,
        content,
        scope,
        format: async (bytes) => (await formatOffThread([bytes]))[0]!,
      }),
    );
  }
  return out;
}

/**
 * Read → format → compare DIRECTIVE TARGETS. NEVER writes. The read-only twin
 * of the gate inside {@link formatChangedSources}, for the
 * `lint-directives-stable` check.
 *
 * Note what it is a function of: the files as they are ON DISK. A displacement
 * exists only while a file is still unformatted — once the build has written
 * the formatted bytes, `formatSource` is the identity and there is nothing left
 * to compare. That is exactly why this cannot be the primary defense: it is
 * structurally green the moment the damage has landed. The gate in
 * `formatChangedSources` is what stops it landing; this is the surface that
 * names the problem on the `push`/standalone-check path, which never builds.
 */
export async function findDisplacedDirectives(
  root: string,
  changed: ChangedFile[],
): Promise<DirectiveDisplacement[]> {
  // Formatting runs on the format thread, as in `findUnformatted` (and shares
  // its remembered results, so a pass formats each file once). Comparing the
  // directive targets stays here, pausing between files.
  const sources = await readSources(root, changed);
  const formatted = await scopedOffThread(sources);
  const slice = createTimeSlicer();
  const displaced: DirectiveDisplacement[] = [];
  for (const [i, source] of sources.entries()) {
    await slice();
    displaced.push(
      ...(await findDirectiveDisplacements({
        file: source.file,
        before: source.content,
        after: formatted[i]!,
      })),
    );
  }
  return displaced;
}

/**
 * Read → format in scope → write-iff-different, over the branch's changed set:
 * prettier's changes to the lines the branch changed, never to the rest of a
 * file (`./line-scope`). Returns the paths actually rewritten.
 *
 * Three properties are load-bearing:
 *
 * - **Write only on byte difference.** Web artifacts are fingerprinted on
 *   `(mtimeMs, size)`, so an unconditional write would invalidate an artifact
 *   whose bytes never changed. It is also what makes the pass cheap after a
 *   branch's first build (0–3 files touched).
 * - **Re-read immediately before writing.** The build lock serializes builds,
 *   not the agent's editor. An edit landing mid-pass would otherwise be
 *   clobbered by bytes derived from a stale read, so a file whose bytes moved
 *   since the read is skipped and logged rather than overwritten.
 * - **Refuse to write a change that displaces a positional lint directive.**
 *   This is the ONLY place in the repo that holds both the pre- and post-format
 *   bytes of a file, so it is the only place that can see a
 *   `// eslint-disable-next-line` change what it suppresses. Write the bytes and
 *   the evidence is gone: a widened directive then silently hides violations
 *   nobody vetted, and every later gate is structurally green. So the displacing
 *   files are left untouched and the whole pass THROWS at the end — an agent is
 *   forced to fix the directive explicitly rather than discover it later.
 *
 * The throw comes after the loop, not at the first offender: every displacement
 * in the changed set is reported at once, so a fix is one pass rather than one
 * build per site. Non-displacing files are still written — formatting is
 * idempotent and per-file, so partial progress needs no rollback.
 */
export async function formatChangedSources(opts: {
  root: string;
  log?: (line: string) => void;
}): Promise<{ formatted: string[] }> {
  const { root, log } = opts;
  const files = await listChangedFormattableFiles(root);
  const formatted: string[] = [];
  const displaced: DirectiveDisplacement[] = [];

  for (const { file: rel, scope } of files) {
    const abs = join(root, rel);
    const content = await readFile(abs, "utf8");
    const next = await formatInScope({
      file: rel,
      content,
      scope,
      format: formatSource,
    });
    if (next === content) continue;

    const moved = await findDirectiveDisplacements({
      file: rel,
      before: content,
      after: next,
    });
    if (moved.length > 0) {
      displaced.push(...moved);
      log?.(
        `format: REFUSED ${rel} — formatting would displace ${moved.length} lint directive(s)`,
      );
      continue;
    }

    const current = await readFile(abs, "utf8");
    if (current !== content) {
      log?.(`format: skipped ${rel} — changed on disk during the pass`);
      continue;
    }

    await writeFile(abs, next, "utf8");
    formatted.push(rel);
    log?.(`format: rewrote ${rel}`);
  }

  if (displaced.length > 0) {
    throw new Error(formatDirectiveDisplacementReport(displaced));
  }

  return { formatted };
}
