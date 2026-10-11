import type { CommitRow, CommitTrailer } from "../../core";

// %x09 = tab between fields; %x00 = NUL between records. Subjects are emitted
// last so any literal tabs in the subject don't shift later fields.
//
// The trailers field is every `Key: value` trailer of the message, unfolded to
// one line each, joined by %x1f (unit separator) with %x1e (record separator)
// between key and value — two bytes no trailer can contain, so neither a `:` in
// a value nor a tab can split it wrong.
export const LOG_FORMAT =
  "%H%x09%h%x09%P%x09%an%x09%ae%x09%aI%x09" +
  "%(trailers:only,unfold,separator=%x1f,key_value_separator=%x1e)%x09%s%x00";

function parseTrailers(field: string): CommitTrailer[] {
  const trailers: CommitTrailer[] = [];
  for (const entry of field.split("\x1f")) {
    const sep = entry.indexOf("\x1e");
    if (sep < 0) continue;
    trailers.push({
      key: entry.slice(0, sep).trim(),
      value: entry.slice(sep + 1).trim(),
    });
  }
  return trailers;
}

export function parseGitLog(out: string): CommitRow[] {
  const rows: CommitRow[] = [];
  for (const raw of out.split("\0")) {
    const line = raw.replace(/^\n/, "");
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 8) continue;
    const [
      sha,
      shortSha,
      parentsStr,
      authorName,
      authorEmail,
      authoredAt,
      trailersStr,
      ...rest
    ] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      ...string[],
    ];
    // Subject can contain tabs — rejoin any extra fields beyond the 8th.
    const subject = rest.join("\t");
    const parents =
      parentsStr.length > 0 ? parentsStr.split(" ").filter(Boolean) : [];
    rows.push({
      sha,
      shortSha,
      subject,
      authorName,
      authorEmail,
      authoredAt,
      parents,
      trailers: parseTrailers(trailersStr),
    });
  }
  return rows;
}
