import { hash53 } from "@plugins/packages/plugins/string-hash/core";

/**
 * Bound a culprit signature to `cap` chars WITHOUT merging distinct signatures.
 *
 * The signature is a `Map` key in both detector tiers, so slicing it mid-string
 * collapses deep nodes whose distinguishing tail (the leaf-most `nth-of-type`
 * segments) lies past the cap onto one key. Instead, an over-long signature
 * keeps its head segment (the plugin part — what a report groups by) and as many
 * whole trailing segments as fit (the leaf-most path — what tells nodes apart),
 * and folds the elided middle into `…#<hash of the whole signature>…`. Two
 * different signatures therefore stay different, and the kept text stays
 * readable segment by segment.
 *
 * Segments are the signature's own separators: ` | ` between parts, `>` between
 * path steps. Each segment keeps its trailing separator.
 */
export function capSignature(full: string, cap: number): string {
  if (full.length <= cap) return full;
  const mark = `…#${hash53(full).toString(36)}…`;
  const budget = cap - mark.length;
  const segments = full.split(/(?<= \| |>)/);

  const first = segments[0] ?? "";
  const head = segments.length > 1 && first.length <= budget / 2 ? first : "";
  let room = budget - head.length;

  let tail = "";
  for (let i = segments.length - 1; i >= (head ? 1 : 0); i -= 1) {
    const seg = segments[i] ?? "";
    if (seg.length > room) {
      // Not even the leaf-most segment fits whole: keep its end (the
      // `nth-of-type(k)` index lives there); the hash keeps it distinct.
      if (!tail) tail = seg.slice(seg.length - room);
      break;
    }
    tail = seg + tail;
    room -= seg.length;
  }
  return head + mark + tail;
}
