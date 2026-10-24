import type { PushPolicy } from "./settings";

/** A variable an automation fills into its prompt template on every run. */
export interface PromptVariable {
  name: string;
  /** What it holds, for the person editing the template. */
  description: string;
}

/**
 * The variable every automation's template may use: the paragraph saying what
 * the Push setting lets the agent do. A template without it never tells the
 * agent it may push, so it never does.
 */
export const PUSH_POLICY_VARIABLE: PromptVariable = {
  name: "pushPolicy",
  description: "What the Push setting allows, as an instruction",
};

/** The paragraph `{{pushPolicy}}` becomes. */
export const PUSH_POLICY_TEXT: Record<PushPolicy, string> = {
  never:
    "Do NOT push. When the build is `ok`, stop and raise a flag so a person reviews the branch — say what changed and why.",
  safe: 'Push with `./equin push -m "…"` ONLY if the change is uncontroversial: small and local, no behaviour or API a person relies on changes, no design choice is left to make, and every check passes. **You are authorized to push such a change without asking.** Anything else: do NOT push — raise a flag that says what needs a decision.',
  checks:
    '**You are authorized to push this task\'s change without asking** once every check passes and the build is `ok`: `./equin push -m "…"`.',
};

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g;

/** The variable names a template uses, in order of first use. */
export function templateVariables(template: string): string[] {
  const seen: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** The names a template uses that `declared` does not offer. */
export function unknownTemplateVariables(
  template: string,
  declared: readonly PromptVariable[],
): string[] {
  const known = new Set(declared.map((v) => v.name));
  return templateVariables(template).filter((n) => !known.has(n));
}

export type RenderedPrompt =
  { ok: true; text: string } | { ok: false; unknown: string[] };

/**
 * Fill a template: every `{{name}}` replaced by `values[name]`. A name with no
 * value is refused as a whole — never rendered blank, which would hand an agent
 * a task with a hole where its evidence was.
 */
export function renderPrompt(
  template: string,
  values: Readonly<Record<string, string>>,
): RenderedPrompt {
  const unknown = templateVariables(template).filter(
    (n) => values[n] === undefined,
  );
  if (unknown.length > 0) return { ok: false, unknown };
  return {
    ok: true,
    text: template.replace(PLACEHOLDER, (_, name: string) => values[name]!),
  };
}
