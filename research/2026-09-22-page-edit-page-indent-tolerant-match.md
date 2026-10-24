# edit_page: tolerate a uniform indentation shift in `old_string`

## Context

`edit_page` searches for `old_string` only in the markdown of what is nested
under `block_id`, which starts at depth zero
(`readBlockAsMarkdown`, `plugins/page/plugins/markdown-apply/server/internal/read.ts:188`).
The block's own line is not included. In the case that prompted this, a bullet
inside a `<todo id="…">` card had four leading spaces in the whole-page read and
two in a read of the card. The agent copied the line from the page read and
edited through the card's id, and got "old_string was not found". The message
wrongly suggested hidden private cards as the cause. The reverse mistake fails
the same way: the agent copies from a read of the card, then edits through the
page id.

Goal: when no exact match exists, accept `old_string` that is the right text at
a different depth. The whole snippet can be shifted as one unit, but the
indentation between its lines must still match exactly.

## Design

### Matching (new pure helper)

New file `plugins/page/plugins/annotations/plugins/agent-access/server/internal/indent-match.ts`
(private to the plugin, since `edit_page` is the only user), exporting one
function:

```ts
findEdits(markdown, oldString, newString): Edit[]
// Edit = { start, end, replacement, shift: { from: string; to: string } | null }
```

1. **Exact first.** Search for `oldString` with no indentation changes (the
   non-overlapping scan `countOccurrences` does today). If it matches at least
   once, return those matches with `shift: null`. Nothing changes for callers
   that already get an exact match.
2. **Shifted retry** runs only when there is no exact match:
   - Split `oldString` into lines. `from` is the leading whitespace common to
     every line that has text (lines with only whitespace don't count). If
     those lines don't all start with the same whitespace string (for example,
     a mix of tabs and spaces), there is no shifted match.
   - Remove `from` from the start of every line. Call the result `D`.
   - For each line of `markdown` in turn: the match may start there only if the
     line is some whitespace `to`, followed by the first line of `D`, and
     nothing else (the match starts at the beginning of a line). The next lines
     must be exactly `to + D[j]`. The final line of `D` only has to be the start
     of `to + …`, so a match can still end partway through a line. A line in
     `D` that is blank matches any line that is blank or only whitespace, so
     blank lines inside a nested item don't depend on how the reader writes
     them.
   - Matches don't overlap. The rule is line-based: a shifted match always
     begins at a line start. A single-line `old_string` with no leading
     whitespace is always an exact search, so it never gets to this step.
3. **Replacement.** Change the indentation of `newString` from `from` to `to`:
   on every line that has text, the leading `from` becomes `to`. Blank lines
   stay empty. **If a line with text in `newString` doesn't start with `from`,
   the edit is refused.** That line is less indented than the snippet it
   replaces, and there is no single correct depth for it (the error names the
   line).

### Handler changes (`mcp-tools.ts`, `edit_page`, ~lines 652–678)

- Replace `countOccurrences` and the manual `slice`/`split` splice with
  `findEdits`. Apply the edits starting from the end of the text, so earlier
  positions stay valid. With `replace_all`, each match uses its own `to`
  (matches at different depths are all valid).
- **Uniqueness is unchanged.** More than one match without `replace_all` is
  still an error. For shifted matches, the message lists the indentation depth
  of each match, for example: "matches 2 times after re-indenting (at 2 and 6
  spaces)". The agent can then pass a larger block or pass `replace_all`.
- **Zero matches:** keep the current message, but say that indentation shifts
  were already tried. The agent then knows the difference is in the text
  itself, not the leading whitespace.
- **Report the shift.** When a shifted match was used, add
  `reindented: { from: <n>, to: <n> }` (leading-whitespace lengths) to the JSON
  response. The fix is then visible in the result, not silent.
- Everything after the splice (title-banner handling,
  `applyMarkdownToBlock`, authorship policy, stamping) is untouched. It takes
  the new document in the same form as before.
- Remove `countOccurrences` once nothing uses it.

### Tool description

Add one line to the "Contract" list in the `edit_page` description: *If there
is no exact match, the tool retries with every line of `old_string` shifted
left or right by the same amount of leading whitespace. `new_string` gets the
same shift. The indentation between lines must still match exactly.* Update
the `old_string` field description to match.

## Critical files

- `plugins/page/plugins/annotations/plugins/agent-access/server/internal/mcp-tools.ts`:
  the `edit_page` handler and its description.
- `plugins/page/plugins/annotations/plugins/agent-access/server/internal/indent-match.ts`:
  new file.
- `plugins/page/plugins/annotations/plugins/agent-access/server/internal/indent-match.test.ts`:
  new file (pure logic, bun runner, next to its source, like `policy.test.ts`).
- `plugins/page/plugins/annotations/plugins/agent-access/e2e/agent-access-verify.ts`:
  new P12 case, and a line for it in the header comment.
- `plugins/page/plugins/annotations/plugins/agent-access/CLAUDE.md`: one
  sentence under the edit_page prose, if it describes the matching contract.

## Verification

1. `./equin test plugins/page/plugins/annotations/plugins/agent-access`,
   covering these cases in `indent-match.test.ts`:
   - an exact match wins, and no shift is reported
   - a nested line copied with extra indentation still matches (shifted left)
   - a nested line copied without its indentation still matches (shifted right)
   - a snippet spanning several lines, with blank lines inside, keeps the
     indentation between its lines
   - different indentation between lines means no match
   - the same text at two depths gives two matches, with both depths reported
   - with `replace_all`, matches at different depths each get their own
     indentation in `new_string`
   - a line in `new_string` less indented than the snippet is refused
   - a match that ends partway through its last line
   - tabs mixed with spaces is not shifted
   - the case that started this: `"    * This is fishy…"` against a read of
     that block by its own id, where the line starts `"* This is fishy…"`
2. `./equin check type-check` and `./equin build` (background).
3. End to end on the worktree's own build: add a **P12** case to
   `plugins/page/plugins/annotations/plugins/agent-access/e2e/agent-access-verify.ts`.
   That script calls this worktree's `/api/mcp/<conversation>`, not main's
   tools. The case:
   - read an agent page that has a nested bullet, via its page id
   - copy the bullet's line, with its leading spaces, from that read
   - `edit_page` by the bullet's own id, with a `new_string` that adds a card
     under it
   - check the result has `reindented`
   - check the card lands as the bullet's child in the page's rows
   - check the reverse direction (text from a single-block read, edit by the
     page id) the same way
   - check that text matching at two depths is refused and nothing is written
     (compared against the five-column snapshot the script already uses)

   Run with
   `./equin run plugins/page/plugins/annotations/plugins/agent-access/e2e/agent-access-verify.ts`.
