// How much of a hook's output Claude Code hands an agent, and the one way a
// part of the compaction context is cut to fit it.

/**
 * The most of one hook output Claude Code puts in the agent's context, in
 * JavaScript string length (UTF-16 code units — not bytes, not tokens). Past
 * it, the CLI saves the output to a file and the agent gets a ~2 KB preview
 * (the `HCe` threshold `oFe = 1e4` in Claude Code 2.1.319, applied to every
 * hook's `additionalContext`, `systemMessage` and stdout).
 *
 * A COPY of a number the CLI owns, which it may change in any release. Nothing
 * trusts it to be right: it only sizes the parts that can be cut, and whether
 * the agent really got the whole context is read back from its transcript
 * (`compaction-context/delivery-check`), which reports a cut and sends the
 * context in full as a turn.
 */
export const HOOK_OUTPUT_CAP = 10_000;

/**
 * What the endpoint aims to stay under: the cap with room to spare, so a
 * small change of the CLI's cap does not turn every compaction into a
 * fallback turn.
 */
export const COMPACTION_CONTEXT_BUDGET = HOOK_OUTPUT_CAP - 1_000;

/** What joins two parts of the context. */
export const PART_SEPARATOR = "\n\n";

/**
 * `text` cut at a line boundary to at most `budget` characters, the cut lines
 * replaced by `footer(cut)` (a line saying how many were cut and where to read
 * them). `text` itself when it fits; `""` when not even the first line and the
 * footer do.
 */
export function fitToBudget(
  text: string,
  budget: number,
  footer: (cutLines: number) => string,
): string {
  if (text.length <= budget) return text;
  const lines = text.split("\n");
  let used = 0;
  let kept = 0;
  for (; kept < lines.length; kept++) {
    const next = used + lines[kept]!.length + 1; // the line and its newline
    const tail = footer(lines.length - kept - 1);
    if (next + tail.length > budget) break;
    used = next;
  }
  if (kept === 0) return "";
  return [...lines.slice(0, kept), footer(lines.length - kept)].join("\n");
}
