import { HighlightedCode } from "./highlighted-code";
import { readableJson } from "./readable-json";

/**
 * A JSON value, pretty-printed and coloured: strings holding newlines are
 * written across lines (indented below their key) rather than as `\n`
 * escapes — see `readableJson`.
 */
export function JsonCode({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  return (
    <HighlightedCode
      code={readableJson(value)}
      lang="json"
      className={className}
    />
  );
}
