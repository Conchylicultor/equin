# Commit-sha chips in agent text (and the code-contribution arbitration they need)

## Context

Agents constantly reference commits in prose:

> my worktree branched *before* main's `862de5c72`, a row-actions reveal refactor whose
> own commit message describes the same failure mode.

Today that sha is inert text. The reader has to leave the app to learn what it is. Every
other id in the transcript is already live — `att-…`, `conv-…`, `task-…`, `block-…`,
`` `plugin-name` `` all render as chips via `active-data` — so a commit sha is the
conspicuous hole. We want the same treatment: **a backticked sha becomes a chip showing
the commit subject on hover, and opens the commit's diff on click.**

Adding the chip turns out to require fixing one structural defect first (§1). That is not
scope creep: without it the chip is invisible for ~37% of shas, decided by an unrelated
fact about plugin load order.

User decisions, already made:

- **Backticked only.** `` `862de5c72` `` chips; a bare sha in prose does not. Precise, and
  it matches how commits are actually written.
- **Click opens the commit diff pane.**

## 1. The blocker: `display:"code"` contributions cannot decline

`ActiveDataCodeContribution` (`plugins/active-data/web/slots.ts`) declares a **syntactic**
selector (`pattern`, full-match against the backtick content) but its real selector is
`pattern ∧ async resolution`. The host picks on the syntactic half only:

```ts
// plugins/active-data/web/internal/markdown-enhancer.tsx
for (const { pattern, Component } of codeContribs) {
  const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const m = re.exec(text);
  if (m && m[0] === text) return <Component content={text} attrs={{}} />;   // first match wins
}
```

The contributor evaluates the semantic half privately and publishes the outcome as an
**absorbable value**: `plugin-link` renders its own hardcoded plain `<code>` when the text
is not a real plugin, indistinguishable from a success.

`PLUGIN_NAME_RE` is `[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*`. About 37% of real shas start
with `a`–`f`, so `` `abc1234` `` full-matches **both** plugin-link's pattern and a sha
pattern. Whichever contribution comes first wins and renders its fallback; the other is
never consulted. `active-data.tag` is a plain `defineSlot` (not in
`reorder/shared/reorderable-slots.generated.ts`), so the order comes from
`topoSortPlugins` over the generated registry — i.e. **alphabetical path order perturbed
by the import graph**. Stable enough that nobody notices, and it flips silently the day
someone adds an unrelated import edge.

`fallback: ReactNode` threaded into each contributor was the obvious fix and is the wrong
one: declining stays a *rendering convention* a contributor can ignore (which is exactly
the code we are deleting), and `slot-render/CLAUDE.md` already names hand-threaded
fallback props as the anti-pattern. It also cannot distinguish *pending* from *declined*,
so every level below a still-loading candidate mounts and fires its I/O for an answer
about to be discarded.

### The fix: the host asks, the contributor answers, the host renders

A three-arm claim, mirroring live-state's two-channel model (`pending` = no trustworthy
answer; `declined` = determinate non-answer with a reason; `claimed` = resolved):

```ts
// plugins/active-data/web/claim.ts (new)
export type CodeClaim<T> =
  | { status: "pending" }
  | { status: "declined"; reason: string }
  | { status: "claimed"; value: T };
```

A contribution supplies a `useClaim` hook **and** a component that is unreachable except
on a claim, sealed together by a `codeTag<T>()` factory (the single erasure site —
`CodeResolver<T>` is invariant in `T`, so the union arm cannot name it; the cast is sound
because the host only ever calls `component` with the value its own `useClaim` produced):

```ts
// plugins/active-data/web/slots.ts
export interface ActiveDataCodeContribution {
  display: "code";
  id: string;              // chain key + doc label
  pattern: RegExp;         // SYNTACTIC gate only
  resolver: CodeResolver<unknown>;   // SEMANTIC gate — build with codeTag()
}
```

Registered like this:

```ts
ActiveData.Tag(codeTag({
  id: "plugin-link",
  pattern: PLUGIN_NAME_RE,
  useClaim: usePluginClaim,   // (text) => CodeClaim<PluginNode>
  component: PluginLinkChip,  // ({ content, value: PluginNode }) — pure renderer
}))
```

There is no way to express "I couldn't handle this, here's a plain code element." The type
has no such shape.

The arbiter is a recursive component, so the chain is **lazy by construction** — level
*i+1*'s element does not exist until level *i* declines:

```tsx
// plugins/active-data/web/internal/code-chain.tsx (new)
function CodeChainLevel({ text, candidates, index }) {
  const next = candidates.findIndex((c, i) => i >= index && c.test.test(text));
  if (next < 0) return <InlineCode>{text}</InlineCode>;      // terminal, host-owned
  const c = candidates[next]!;
  const claim = c.useClaim(text);
  switch (claim.status) {
    case "pending":  return <InlineCode>{text}</InlineCode>;  // NOT the next level — see below
    case "declined": return <CodeChainLevel key={c.id} text={text} candidates={candidates} index={next + 1} />;
    case "claimed":  return <c.Component content={text} value={claim.value} />;
  }
}
```

`pending` rendering the terminal rather than the next level is the point of the third arm.
Worked example — 40 backticked sha-shaped tokens, chain `[plugin-link, commit]`, cold
plugin-tree cache: with a two-arm protocol plugin-link's load window mounts 40 commit chips
that fire 40 sha lookups, then the tree lands, plugin-link declines, and they all remount.
With three arms: zero requests in that window, 40 after it settles, no flicker.

Notes that shape the code:

- `ActiveDataCodeChain` must read the registry itself, not take candidates as a prop:
  `markdown-renderer.tsx` memoizes the whole `<ReactMarkdownLib>` element, so `inlineCode`
  runs ~once per code span and the element it returns lives in a frozen tree — a prop
  would freeze a boot-time snapshot into it.
- `markdown-enhancer.tsx`'s `inlineCode` keeps returning `null` when **no** candidate
  pattern matches, so the next enhancer plugin (`markdown-extensions`' URL/file-path
  `CodeEnhancer`) still gets its turn.
- The regexes get precompiled once in the candidates `useMemo` instead of
  `new RegExp(...)` per code span per call.
- `attrs` is dropped from the code component's props — it is permanently `{}`. It stays on
  `inline`/`block`, where it is real.

### What deliberately does *not* change

**`display:"inline"` keeps leftmost-longest.** Inline patterns are self-certifying —
`att-`, `conv-`, `task-`, `block-` are namespaced prefixes and every inline chip renders
unconditionally (degraded dot for unknown ids). There is no semantic gate to hoist. More
decisively, `node-extension-bridge.ts` compiles every inline pattern into **one union
regex** feeding a single Lexical `ActiveDataInlineNode`; a "declined" token would still be
a committed node in the user's document. Inline's contract is *the pattern alone is the
truth*, and it must hold in markdown, plain text, and the editor from one registry. Record
that invariant as a comment above `ActiveDataInlineContribution`: *a pattern whose validity
requires I/O belongs in `display:"code"`.*

**`display:"block"`** dispatches on an exact tag string — a closed-key lookup. Two plugins
claiming `<task>` is a duplicate-key bug, answered by a dev-time assertion, not a chain.

## 2. The commit-info endpoint

No endpoint resolves a sha to its metadata today. Add one beside `getCommitFiles`, in the
same contract file for the same reason `code-api` exists (a leaf both `code-explorer` and
conversation-side consumers import without forming a cycle):

```ts
// plugins/code-explorer/plugins/code-api/core/endpoints.ts
export const getCommitInfo = defineEndpoint({
  route: "GET /api/code/:worktree/commit-info",
  query: z.object({ sha: z.string() }),
  response: resolvableSchema(CommitRowSchema),
});
```

`Resolvable<T>` (`primitives/live-state/core`) rather than a bespoke `{found}` union — it
already means "determinate answer, and the answer is that there is nothing here", it
already carries a `reason`, and `commits-graph/shared/protocol.ts` already uses it for the
analogous case. `CommitRowSchema` comes from `primitives/commit-list/core`
(sha, shortSha, subject, authorName, authorEmail, authoredAt, parents) — no new type, and
`commit-list` has no edge back to `code-explorer`.

Handler (`plugins/code-explorer/server/internal/commit-info-handler.ts`, wired into
`code-explorer/server/index.ts` `httpRoutes`), reusing `LOG_FORMAT` + `parseGitLog` +
`tryRunGit` from `commit-list/server` and `isAllowedRef` from `internal/resolve-ref.ts`:

```ts
if (!isAllowedRef(query.sha)) throw new HttpError(400, "Invalid sha");
const wtPath = await resolveWorktreePath(worktree);
if (!wtPath) throw new HttpError(404, "Not found");
const result = await tryRunGit(["log", "-1", `--format=${LOG_FORMAT}`, query.sha, "--"], wtPath);
if (!result.ok) return unresolved(`no commit ${query.sha}`);
return resolved(parseGitLog(result.stdout)[0]!);
```

- malformed sha → 400; unknown worktree id → 404 (byte-for-byte `handleCommitFiles`);
  unknown sha in a valid worktree → **200 `unresolved`**, never a 404.
- `WorktreeGoneError` propagates as a 500, uncaught — same as the sibling handler, and
  what that error type is for.
- No `%B` full body: `CommitRowSchema` covers the tooltip (subject, author, date) and the
  pane title, and `WithTooltip` caps at `max-w-xs`. Additive later if wanted.

## 3. One shared, worktree-parameterized commit-detail pane

The existing commit diff pane cannot be reused as-is: it derives its worktree from an
**ancestor** `conversationPane`, so pushed from anywhere else it renders `null`.

```tsx
// commits-graph/web/panes.tsx — today
const convId = conversationPane.useRouteEntry()?.params.convId;
const conversation = useConversationById(convId ?? null);
if (!conversation) return null;
<CommitDiffView worktree={conversation.attemptId} sha={sha} />
```

Extract it into **`plugins/code-explorer/plugins/commit-detail/`**, with the worktree in
the pane's own params — the shape `build-profile/:worktree/:buildId` and
`file/:worktree/:filePath*` already use:

```ts
export const commitDetailPane = Pane.define({
  id: "commit-detail",
  segment: "commit/:worktree/:sha",
  component: CommitDetailBody,
  chrome: { history: false },
  width: 720,
  resolve: false,
});
```

- **Moved verbatim** (import paths only): `commits-graph/web/components/commit-diff-view.tsx`
  and `commits-graph/web/use-commit-files.ts`.
- **New**: `web/panes.tsx`, `web/use-commit-info.ts` (returns a 3-arm
  `loading | found | not-found`, the shape `useCommitFiles` already models), `web/index.ts`
  exporting only `commitDetailPane`, `useCommitInfo`, `CommitInfoState`. `CommitDiffView`
  stays internal — nothing outside needs it once the old pane is gone.
- `CommitDetailBody` titles itself with the resolved subject (short sha while
  loading/unknown) and renders `<CommitDiffView worktree={worktree} sha={sha}/>` unchanged.
- **`convCommitDiffPane` is deleted**, not kept as a wrapper: drop it and `ConvCommitDiffBody`
  from `commits-graph/web/panes.tsx`, drop its `Pane.Register`, and repoint
  `commits-graph-body.tsx`'s row click to
  `openPane(commitDetailPane, { worktree: conversation.attemptId, sha: c.sha }, { mode: "push" })`.

Cycle check: the new edge is `commits-graph → code-explorer/commit-detail`; `commit-detail`
needs only `conversation-view/code/core` (for `EditedFile`, which the moved file already
imports) and that leaf references nothing in `code-explorer`. Opening another plugin's pane
is the established chip shape — `AttemptChip` opens `attemptPane` from `tasks/attempt-view`.

Flagged: the diff route moves from nested `commits/d/:sha` to top-level
`commit/:worktree/:sha`. The old pane was already `resolve:false` + `history:false`, so no
deep-link contract is broken, but an old bookmark would 404.

## 4. `plugins/active-data/plugins/commit-link/`

```
plugins/active-data/plugins/commit-link/
├── package.json                        # @singularity/plugin-active-data-commit-link
├── CLAUDE.md
└── web/
    ├── index.ts
    ├── internal/pattern.ts
    ├── internal/pattern.test.ts
    ├── internal/use-commit-claim.ts
    └── components/commit-link-chip.tsx
```

No `panes.tsx` — it opens `commitDetailPane`.

**Pattern** — anchored, not `inlineBoundary` (that helper guards substring scanning in
prose; the code path already requires a full-string match, so the boundary assertions are
dead weight here):

```ts
export const COMMIT_SHA_RE = /^(?=.*[a-f])[0-9a-f]{7,40}$/;
```

7 = git's minimum `%h` abbreviation, 40 = full SHA-1. The `(?=.*[a-f])` lookahead is what
keeps `` `1786055151` `` (a request id, a port, a count) from becoming a lookup — digits
are a subset of hex. It costs the ~3.4% of real 7-char shas that happen to be all-digits;
those fall through as plain code. Deliberate: a false negative is invisible, a false
positive is a request per code span.

**Claim** (`use-commit-claim.ts`) — the unblocked consumer of §1:

```ts
export function useCommitClaim(sha: string): CodeClaim<CommitRow> {
  const q = useEndpoint(getCommitInfo, { worktree: "main" }, { query: { sha }, staleTime: Infinity });
  if (q.isPending) return claimPending();
  if (q.isError) return declined("commit lookup unavailable");
  return q.data.resolved ? claimed(q.data.value) : declined(q.data.reason);
}
```

**Component** — a pure renderer, reached only on a claim:

```tsx
export function CommitLinkChip({ content, value }: { content: string; value: CommitRow }) {
  const openPane = useOpenPane();
  return (
    <WithTooltip content={<>{value.subject}<div className="text-muted-foreground">{value.authorName} · {…date}</div></>}>
      <LinkChip
        onClick={(e) => { e.stopPropagation();
          openPane(commitDetailPane, { worktree: "main", sha: value.sha }, { mode: "push" }); }}
        leading={<MdCommit className="text-muted-foreground" />}
        mono
      >{content}</LinkChip>
    </WithTooltip>
  );
}
```

**Worktree is always `"main"`, never the conversation's attempt.** Worktrees are created
with `git worktree add` (`infra/worktree/server/internal/worktree.ts`), so every checkout
shares one object database — `git log -1 <sha>` is an object-graph lookup, not a
reachability-from-HEAD check, and a commit made on any branch resolves from the main
checkout. `ensureMainWorktreeRoot()` self-heals; an attempt's DB-stored `worktreePath` goes
stale the moment `worktree-cleanup` reaps it. The payoff: the chip needs **zero**
conversation-awareness — no `conversationPane`, no `useConversationById`, no dependency on
`conversations` — which is what makes it correct on the surfaces that have no conversation
in scope (task descriptions, the memory viewer, the story renderer, the file-pane markdown
preview; the enhancer is registered globally, so chips render everywhere `<Markdown>` and
`<InlineText>` do). The happy path and the no-conversation path are the same path.

**Caching.** `useEndpoint` keys on `["endpoint", route, params, query]`, so one request per
*distinct* sha, shared across every chip rendering it. Commit metadata is immutable, hence
`staleTime: Infinity` — fetched once per session. No batching primitive: each request is
one `git log -1`, and building a cross-component sha collector has no precedent here and no
measured need.

## 5. Guardrails

The type is the primary one and it is free: after §1, "matched syntactically but cannot
resolve" has **no representable rendering**, enforced by `tsc`. On top of that:

- `plugins/active-data/web/__tests__/code-arbitration.test.tsx` (vitest, fixture
  contributions only — the `editor-bridge.test.tsx` pattern): A declines → B renders;
  **the same fixtures in reversed registration order produce identical output** (the
  assertion that would have caught the original bug); both decline → exactly one `<code>`;
  A pending → plain `<code>` and B's `useClaim` is never called.
- `plugins/active-data/plugins/commit-link/web/internal/pattern.test.ts` (bun:test): real
  7/40-char shas match; all-digit strings don't; >40 hex doesn't; uppercase doesn't.
- `plugins/active-data/check/index.ts` contributing `active-data:no-adhoc-inline-code` —
  `grepCode` for `<code` under `plugins/active-data/**`, pointing at `<InlineCode>`. A
  **check, not a lint rule**: contributed lint rules run repo-wide and there are dozens of
  legitimate `<code>` sites elsewhere; a check can be path-scoped.
- Dev-loud `console.error` on duplicate contribution `id`/`tag` at registry read, and on
  the silent overlap skip in `linkify-active-data.tsx`'s `applyPatterns`.

## 6. One `<code>`, one definition

Extract `plugins/primitives/plugins/markdown/web/internal/inline-code.tsx` carrying today's
base styling (`rounded-md bg-muted px-xs py-2xs font-mono text-caption`, spreading `rest`)
from `base-components.tsx:107-114`; `base-components.tsx` and the chain terminal both use
it. plugin-link's divergent `rounded-sm … text-xs` copy and its `no-adhoc-typography`
disable disappear with it. This is a real (intended) pixel diff on unresolved
plugin-shaped code spans — worth a screenshot.

## Files

| File | Change |
|---|---|
| `active-data/web/claim.ts` | **new** — `CodeClaim<T>` + `claimPending`/`declined`/`claimed` |
| `active-data/web/slots.ts` | code contribution gains `id`+`resolver`, drops `attrs`; `codeTag<T>()`; inline self-certifying invariant comment |
| `active-data/web/internal/code-chain.tsx` | **new** — the arbiter |
| `active-data/web/internal/use-code-replace.ts` | → `useActiveDataCodeCandidates`; precompiled regexes; dup-`id` assertion; un-exported |
| `active-data/web/internal/markdown-enhancer.tsx` | `inlineCode` → syntactic pre-test → `null` or `<ActiveDataCodeChain>` |
| `active-data/web/internal/linkify-active-data.tsx` | dev-loud overlap warning |
| `active-data/web/index.ts` | export claim API; **remove** `useActiveDataCodeReplace`, `CodeReplaceContrib` (no consumers) |
| `primitives/markdown/web/internal/inline-code.tsx` + `index.ts` + `base-components.tsx` | **new** `InlineCode`, exported, used by the base map |
| `active-data/plugins/plugin-link/web/{internal/use-plugin-claim.ts, components/plugin-link-chip.tsx, index.ts, CLAUDE.md}` | claim migration; chip becomes a pure renderer (delete its endpoint/memo/`<code>` block); hoist the tree index off the per-chip `useMemo`; drop the `PluginLinkChip` re-export (no importers) |
| `code-api/core/endpoints.ts` | **new** `getCommitInfo` contract |
| `code-explorer/server/internal/commit-info-handler.ts` + `server/index.ts` | **new** handler + route |
| `code-explorer/plugins/commit-detail/**` | **new plugin** — `commitDetailPane`, `useCommitInfo`, moved `commit-diff-view.tsx` + `use-commit-files.ts` |
| `commits-graph/web/{panes.tsx, index.ts, components/commits-graph-body.tsx}` | delete `convCommitDiffPane`; repoint clicks at `commitDetailPane` |
| `active-data/plugins/commit-link/**` | **new plugin** — pattern, claim, chip |
| `active-data/check/index.ts`, two test files | **new** guardrails |

Confirmed unaffected: the Lexical editor bridge (filters `display:"inline"`; the
discriminant is unchanged, only a sibling arm gained fields) and all three existing
active-data vitest files (all inline fixtures).

## Verification

1. `./equin build` → `http://att-1786055151-uzfs.localhost:9000` (regenerates the two
   plugin registries and the doc autogen blocks; `plugins-doc-in-sync` /
   `plugins-registry-in-sync` fail until it runs).
2. `./equin test plugins/active-data` — the arbitration vitest and the pattern
   bun:test.
3. Post a message containing, all backticked: a real 40-char sha, a real short sha
   (`862de5c72`), a plausible-but-nonexistent hex string, an all-digit 10-char id, and a
   real plugin name (`tasks`). Expect: chips on the first two with subject/author/date
   tooltips; plain code on the next two; a plugin chip on the last — **and** verify the
   plugin chip still works, since it now goes through the claim path.
4. Click a sha chip → the commit-detail pane opens with the subject as its title and the
   file diffs below.
5. Repeat (3) on a surface with **no conversation**: a task description and Debug → Memory.
   Identical behaviour is the proof that the `"main"` decision removed the degraded path.
6. Commit something in a *different* attempt's worktree, don't push, paste that sha
   anywhere — it must still resolve. This is the empirical check on the shared-object-store
   premise the whole worktree decision rests on.
7. Open a conversation's Commits pane and click a row — the moved diff pane must still open
   with `worktree=attemptId`.
8. Order-independence, the reason for §1: temporarily swap the two code contributions'
   registration order (or just run the reversed-order vitest case) and confirm both a sha
   chip and a plugin chip still render.
9. `bun plugins/active-data/plugins/commit-link/e2e/commit-link-verify.ts` — an e2e modelled
   on `page-link`'s, if the chip family's e2e convention is being kept up.

## Deferred (file as tasks, don't fold in)

- **The same bug one level up.** `MarkdownEnhancement.inlineCode` is
  `(text) => ReactNode | null` and `base-components.tsx:103-106` is first-non-null-wins
  across *enhancer plugins* — the same absorbable decline. It is dormant only by luck
  (`FILE_PATH_RE` needs a `/`, `URL_RE` needs `://`, neither of which `PLUGIN_NAME_RE` can
  full-match). It cannot be fixed from inside active-data: the handler stack is built
  parent-first, so active-data at `order:0` sees an empty parent and has no continuation to
  call. The fix is to hoist the arbiter into the markdown primitive — designing §1's
  `CodeCandidate` shape standalone makes that a move, not a rewrite.
- `useActiveDataLinkify` returns a fresh closure every render
  (`linkify-active-data.tsx:124`), defeating downstream memoization. Harmless today only
  because of the `useLatestRef` indirection in the markdown renderer.
- `handleCommitFiles` doesn't validate its sha through `isAllowedRef`, unlike its siblings.
