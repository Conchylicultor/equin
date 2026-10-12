/**
 * Whether the body of an inline-capable tag (the raw text between its open and
 * close tags) is written in block form: a line break inside the tags, i.e. the
 * open tag ends its line. The ONE shape rule for such a tag, read by every
 * surface that draws one — the reply (active-data's segmenter), and a contributor's own plain-
 * text and editor renderings — so a body is a card or a chip everywhere alike.
 * Untrimmed on purpose: `<tag>\nOne line</tag>` is a block of one line.
 */
export function isBlockForm(body: string): boolean {
  return body.includes("\n");
}
