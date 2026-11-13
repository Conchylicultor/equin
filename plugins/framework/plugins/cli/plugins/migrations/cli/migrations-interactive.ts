// The ONE sanctioned streaming-stdio child in the CLI: drizzle-kit's
// interactive create-vs-rename prompts must be parsed from LIVE stdout while
// keystrokes are written back to stdin — impossible over the spawn plugin's
// after-exit temp files. Extracted out of migrations.ts into this file so the
// spawn-safety/no-raw-bun-spawn lint ignore stays surgical (exactly this file,
// nothing else). See plugins/infra/plugins/spawn/CLAUDE.md (exception policy)
// and research/2026-07-22-global-spawn-plugin-wedge-mitigation.md.

import type { PeakFootprint } from "@plugins/packages/plugins/proc-rusage/core";

// ─── Types for interactive prompt handling ───────────────────────────────────

export interface PromptOption {
  index: number;
  action: "create" | "rename";
  label: string;
  fromName?: string;
}

export interface DetectedPrompt {
  index: number;
  entityType: string;
  entityName: string;
  context: string | null;
  question: string;
  options: PromptOption[];
}

export type MigrationAnswer =
  { action: "create" } | { action: "rename"; from: string };

/**
 * Stable identity key for a prompt, used to persist + replay the create-vs-rename
 * decision across regens (where positional order is unstable). For a column
 * prompt the table context disambiguates same-named columns across tables.
 */
export function promptKey(p: DetectedPrompt): string {
  if (p.entityType === "column") return `column:${p.context}.${p.entityName}`;
  return `${p.entityType}:${p.entityName}`;
}

export interface DrizzlePromptResult {
  exitCode: number;
  stdoutBuf: string;
  stderrBuf: string;
  detectedPrompts: DetectedPrompt[];
  /** Prompt keys (promptKey) drizzle showed that had no persisted answer, or
   * whose rename source was missing. Empty unless keyedAnswers was supplied. */
  unanswered: string[];
  /**
   * Peak physical footprint of the drizzle-kit child — always unmeasured: it
   * runs as `bun x`, which cannot load the report preload (`spawn`'s
   * `peakFootprint`). One of the non-heavy build phases that runs under no host
   * admission — see research/2026-07-12-global-host-admission-memory-dimension.md
   * (gap 0); the build threads it onto its `generateMigration` profiler span.
   */
  peakFootprint: PeakFootprint;
}

// ─── ANSI / prompt parsing utilities ─────────────────────────────────────────

const ANSI_RE =
  /\x1b(?:\[[0-9;]*[a-zA-Z]|\[\?[0-9;]*[a-zA-Z]|\][^\x07]*\x07|[()][AB012])/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

const QUESTION_COL_RE =
  /Is (.+?) column in (.+?) table created or renamed from another column/;
const QUESTION_ENTITY_RE =
  /Is (.+?) (table|schema|enum|view|sequence|role|policy) created or renamed/;
const OPTION_CREATE_RE = /[❯ ]\s*\+\s*(.+?)\s+create\s/;
const OPTION_RENAME_RE = /[❯ ]\s*~\s*(.+?)\s*›\s*(.+?)\s+rename\s/;
const CONFIRMATION_RE = /will be (created|renamed|renamed\/moved)/;

interface ParsedQuestion {
  entityType: string;
  entityName: string;
  context: string | null;
  question: string;
}

function tryParseQuestion(line: string): ParsedQuestion | null {
  const colMatch = QUESTION_COL_RE.exec(line);
  if (colMatch) {
    return {
      entityType: "column",
      entityName: colMatch[1]!,
      context: colMatch[2]!,
      question: line.trim(),
    };
  }
  const entityMatch = QUESTION_ENTITY_RE.exec(line);
  if (entityMatch) {
    return {
      entityType: entityMatch[2]!,
      entityName: entityMatch[1]!,
      context: null,
      question: line.trim(),
    };
  }
  return null;
}

function tryParseOption(line: string, index: number): PromptOption | null {
  const createMatch = OPTION_CREATE_RE.exec(line);
  if (createMatch) {
    return { index, action: "create", label: `+ ${createMatch[1]!.trim()}` };
  }
  const renameMatch = OPTION_RENAME_RE.exec(line);
  if (renameMatch) {
    return {
      index,
      action: "rename",
      label: `~ ${renameMatch[1]!.trim()} › ${renameMatch[2]!.trim()}`,
      fromName: renameMatch[1]!.trim(),
    };
  }
  return null;
}

function keystrokesForOptionIndex(optionIndex: number): Uint8Array {
  const parts: number[] = [];
  for (let i = 0; i < optionIndex; i++) parts.push(0x1b, 0x5b, 0x42); // arrow-down
  parts.push(0x0d); // enter
  return new Uint8Array(parts);
}

/**
 * Resolve an answer to an option index, or `null` if it can't be satisfied
 * (a rename whose source isn't among the prompt's options — e.g. consumed by a
 * prior rename, or no longer present after a rebase). The non-throwing core so
 * the keyed (regen) path can record a gap instead of using exceptions for flow.
 */
function tryResolveAnswer(
  prompt: DetectedPrompt,
  answer: MigrationAnswer,
): number | null {
  if (answer.action === "create") return 0;
  const idx = prompt.options.findIndex(
    (o) => o.action === "rename" && o.fromName === answer.from,
  );
  return idx === -1 ? null : idx;
}

export function resolveAnswer(
  prompt: DetectedPrompt,
  answer: MigrationAnswer,
): number {
  const idx = tryResolveAnswer(prompt, answer);
  if (idx === null) {
    // tryResolveAnswer only returns null for a rename whose source is missing —
    // "create" always resolves to option 0. Narrow for the diagnostic.
    const from = answer.action === "rename" ? answer.from : "";
    const available = prompt.options.map((o) => o.label).join(", ");
    throw new Error(
      `Answer specifies rename from "${from}" but prompt for ` +
        `"${prompt.entityName}" only has options: [${available}].\n` +
        `The source may have been consumed by a prior rename answer.\n\n` +
        `AGENT: Stop here and report this error to the user. Do not retry ` +
        `without understanding why the expected rename source is missing.`,
    );
  }
  return idx;
}

// ─── Core runner ─────────────────────────────────────────────────────────────

/**
 * Run drizzle-kit with interactive prompt handling.
 *
 * - answers=null (detect mode): advances each prompt with "create" (option 0)
 *   to discover all prompts. The caller must discard any generated files.
 * - answers=[...] (answer mode): uses the provided semantic answers to select
 *   the correct option for each prompt.
 */
export async function runDrizzleKitWithPrompts(opts: {
  cmd: string[];
  cwd: string;
  /**
   * Extra environment for the child, REPLACING the parent's when given. Omit it
   * — the ordinary case — and the child simply inherits this process's
   * environment, which is what drizzle-kit wants: it needs `PATH` and nothing
   * else, and every value a caller once added to this map has since moved to an
   * explicit argument. `NO_COLOR` is added either way, below.
   *
   * Typed with `| undefined` values because that is what `process.env` really
   * holds and what `Bun.spawn` really accepts; a `Record<string, string>` here
   * made the plain inherit-everything spelling a type error.
   */
  env?: Record<string, string | undefined>;
  answers: MigrationAnswer[] | null;
  /**
   * Identity-keyed answers (used by regen, where positional order is unstable).
   * Takes precedence over `answers`: when set, positional `answers` is ignored
   * and each prompt is resolved by its promptKey. Missing keys (or a stale
   * rename source) are pushed onto the returned `unanswered` and advanced with
   * option 0 so discovery continues rather than killing the process.
   */
  keyedAnswers?: Map<string, MigrationAnswer>;
  /** If true, echo stdout/stderr to the parent process streams. */
  echo?: boolean;
}): Promise<DrizzlePromptResult> {
  const { cmd, cwd, env, answers, keyedAnswers, echo = false } = opts;

  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...(env ?? process.env), NO_COLOR: "1" },
  });

  const detectedPrompts: DetectedPrompt[] = [];
  const unanswered: string[] = [];
  let promptIndex = 0;
  let awaitingConfirmation = false;
  let currentQuestion: ParsedQuestion | null = null;
  let currentOptions: PromptOption[] = [];

  function flushPrompt(stdin: typeof proc.stdin) {
    if (!currentQuestion || currentOptions.length === 0) return;
    const prompt: DetectedPrompt = {
      index: promptIndex,
      entityType: currentQuestion.entityType,
      entityName: currentQuestion.entityName,
      context: currentQuestion.context,
      question: currentQuestion.question,
      options: currentOptions,
    };
    detectedPrompts.push(prompt);

    let optIdx = 0;
    if (keyedAnswers) {
      // Keyed (regen) mode: resolve by entity identity, not position. Missing or
      // unresolvable answers don't kill the process — we record them and keep
      // discovering with option 0 so the caller can report every gap at once and
      // discard the generated files.
      const a = keyedAnswers.get(promptKey(prompt));
      const idx = a === undefined ? null : tryResolveAnswer(prompt, a);
      if (idx === null) {
        unanswered.push(promptKey(prompt));
        optIdx = 0;
      } else {
        optIdx = idx;
      }
    } else if (answers) {
      if (promptIndex >= answers.length) {
        console.error(
          `\nError: drizzle-kit showed prompt ${promptIndex + 1} but only ` +
            `${answers.length} answer(s) were provided.\n` +
            `Re-run without --migration-answers to discover all prompts.\n\n` +
            `AGENT: Stop here and report this limitation to the user. The ` +
            `number of prompts exceeded the provided answers. Do not retry ` +
            `without first re-running in detect mode.`,
        );
        proc.kill();
        return;
      }
      try {
        optIdx = resolveAnswer(prompt, answers[promptIndex]!);
      } catch (e: unknown) {
        console.error(`\n${e instanceof Error ? e.message : String(e)}`);
        proc.kill();
        return;
      }
    }

    void stdin.write(keystrokesForOptionIndex(optIdx));
    awaitingConfirmation = true;
    promptIndex++;
    currentQuestion = null;
    currentOptions = [];
  }

  let stdoutBuf = "";
  let strippedBuf = "";
  let processedUpTo = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function tryFlushAfterDelay() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      if (
        currentQuestion &&
        currentOptions.length > 0 &&
        !awaitingConfirmation
      ) {
        flushPrompt(proc.stdin);
      }
    }, 100);
  }

  function processBuffer() {
    const unprocessed = strippedBuf.slice(processedUpTo);
    const lines = unprocessed.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      if (awaitingConfirmation) {
        if (CONFIRMATION_RE.test(line)) {
          awaitingConfirmation = false;
        }
        continue;
      }

      const q = tryParseQuestion(line);
      if (q) {
        if (currentQuestion && currentOptions.length > 0) {
          flushPrompt(proc.stdin);
        }
        currentQuestion = q;
        currentOptions = [];
        continue;
      }

      if (currentQuestion) {
        const opt = tryParseOption(line, currentOptions.length);
        if (opt) {
          currentOptions.push(opt);
          tryFlushAfterDelay();
        } else if (currentOptions.length > 0) {
          flushPrompt(proc.stdin);
        }
      }
    }
    processedUpTo = strippedBuf.length;
  }

  const stdoutDone = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (echo) process.stdout.write(value);
      stdoutBuf += chunk;
      strippedBuf += stripAnsi(chunk);
      processBuffer();
    }
    stdoutBuf += decoder.decode();

    if (flushTimer) clearTimeout(flushTimer);
    if (currentQuestion && currentOptions.length > 0 && !awaitingConfirmation) {
      flushPrompt(proc.stdin);
    }
  })();

  let stderrBuf = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (echo) process.stderr.write(value);
      stderrBuf += decoder.decode(value, { stream: true });
    }
    stderrBuf += decoder.decode();
  })();

  const exitCode = await proc.exited;
  await Promise.all([stdoutDone, stderrDone]);

  return {
    exitCode,
    stdoutBuf,
    stderrBuf,
    detectedPrompts,
    unanswered,
    // `bun x` cannot load the preload a peak-footprint report needs, and
    // getrusage's maxRSS counts freed pages: no honest number to give.
    peakFootprint: { kind: "unmeasured", why: "not-requested" },
  };
}
