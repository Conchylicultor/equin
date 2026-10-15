import type { LogLine } from "../../shared/resources";

// What one stored line says about itself. Logs come in three spellings, and the
// reader shows each the same way:
// - a log-channel envelope `{"t":…,"stream":…,"line":…}` (every defineLogSink
//   channel and clientLog file);
// - the gateway's `<RFC 3339> [stdout|stderr] <text>` capture of a backend;
// - anything else, verbatim (a host sink's own JSON records, plain text) — with
//   its time when it is a JSON object carrying a numeric `t` or `at`.

const GATEWAY_LINE = /^(\d{4}-\d\d-\d\dT\S+) \[(stdout|stderr)\] (.*)$/s;

export function parseLine(
  text: string,
): Pick<LogLine, "t" | "stream" | "text"> {
  if (text.startsWith("{")) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return { t: null, stream: null, text };
    }
    if (typeof obj === "object" && obj !== null) {
      const rec = obj as Record<string, unknown>;
      if (typeof rec.t === "number" && typeof rec.line === "string") {
        const stream =
          rec.stream === "stdout" || rec.stream === "stderr"
            ? rec.stream
            : null;
        return { t: rec.t, stream, text: rec.line };
      }
      const t = typeof rec.t === "number" ? rec.t : rec.at;
      return { t: typeof t === "number" ? t : null, stream: null, text };
    }
    return { t: null, stream: null, text };
  }
  const gateway = GATEWAY_LINE.exec(text);
  if (gateway) {
    const t = Date.parse(gateway[1] as string);
    return {
      t: Number.isNaN(t) ? null : t,
      stream: gateway[2] as "stdout" | "stderr",
      text: gateway[3] as string,
    };
  }
  return { t: null, stream: null, text };
}

/** The instant a stored line was written at, for a jump to a time. */
export function timeOfLine(text: string): number | null {
  return parseLine(text).t;
}
