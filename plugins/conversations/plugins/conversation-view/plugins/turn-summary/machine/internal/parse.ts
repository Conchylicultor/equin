// Tolerant parser for Haiku output.
// Expected shape:
//   ## Summary
//   <one-line>
//
//   ## Caveats
//   - bullet
//
//   ## Actions
//   - bullet
//
// Missing sections become empty strings. If no headers are detected at all,
// the whole blob falls into `summary` so the user still sees something.
export function parseMarkdownSections(raw: string): {
  summary: string;
  caveats: string;
  actions: string;
} {
  const trimmed = raw.trim();
  const headerRe = /^##\s+(summary|caveats|actions)\s*$/i;

  const lines = trimmed.split(/\r?\n/);
  let current: "summary" | "caveats" | "actions" | null = null;
  const buckets: Record<"summary" | "caveats" | "actions", string[]> = {
    summary: [],
    caveats: [],
    actions: [],
  };
  let sawAnyHeader = false;

  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      sawAnyHeader = true;
      current = m[1]!.toLowerCase() as "summary" | "caveats" | "actions";
      continue;
    }
    if (current) buckets[current].push(line);
  }

  if (!sawAnyHeader) {
    return { summary: trimmed, caveats: "", actions: "" };
  }

  return {
    summary: buckets.summary.join("\n").trim(),
    caveats: buckets.caveats.join("\n").trim(),
    actions: buckets.actions.join("\n").trim(),
  };
}
