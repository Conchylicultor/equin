// Matches file paths with at least one directory separator, e.g.
// research/2026-04-26-foo.md, docs/plugins.md, ~/.singularity/worktrees/central.json, ~/.zshrc,
// /tmp/promo/video.webm
// Two path shapes:
//   ~/[dirs/]file  — home-rooted; zero or more extra dir segments after ~/
//   [/]dirs/file   — relative or absolute, with at least one dir segment (the
//                    file peek reads an absolute one from the host)
// Final segment must either contain a dot (xx.yy, .zshrc, .tmux.conf) or be a
// well-known extensionless name (Makefile, Dockerfile, …).
// The : and \w in the lookbehind keep URL paths out (localhost:9000/plugins/..., example.com/a/b.png)
// Optional (?::(\d+)(?!\w))? captures a trailing :N line number (e.g. foo.ts:148).
export const FILE_PATH_RE =
  /(?<![\w./~:-])((?:~\/(?:[\w.\-]+\/)*|\/?(?:[\w.\-]+\/)+)(?:[\w\-]*(?:\.[\w\-]+)+|Makefile|Dockerfile|Gemfile|Rakefile|Procfile|Brewfile))(?::(\d+)(?!\w))?(?![\w/-])/g;

// Matches http/https URLs; strips trailing sentence punctuation.
export const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

export interface FileLinkSegment {
  type: "text" | "path" | "url";
  value: string;
  line?: number;
}

type RawMatch = { index: number; end: number; type: "path" | "url"; value: string; line?: number };

export function parseFileLinks(text: string): FileLinkSegment[] {
  const raw: RawMatch[] = [];

  FILE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_RE.exec(text)) !== null) {
    const line = m[2] ? parseInt(m[2], 10) : undefined;
    raw.push({ index: m.index, end: m.index + m[0].length, type: "path", value: m[1] ?? "", line });
  }

  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    // Strip trailing sentence punctuation that isn't part of the URL.
    const url = m[0].replace(/[.,;:!?]+$/, "");
    raw.push({ index: m.index, end: m.index + url.length, type: "url", value: url });
  }

  raw.sort((a, b) => a.index - b.index);

  const segments: FileLinkSegment[] = [];
  let lastIndex = 0;
  for (const r of raw) {
    if (r.index < lastIndex) continue; // skip overlapping matches
    if (r.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, r.index) });
    }
    segments.push({ type: r.type, value: r.value, line: r.line });
    lastIndex = r.end;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}
