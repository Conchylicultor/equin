# Places: Ask Sonnet in the universal search, as an embedded agent thread

Task: task-1792544109-kphz0p · Track: "Universal search" (block-ef922c48-b280-4db9-861a-f60d99c7c5b2) ·
Design: "Embedded conversation view" → *First client: Places Ask Sonnet* (block-b8192e78-a010-421e-8443-c7d0ba327b3c) ·
Prototype: proto-1791725279-9yramg, `ai: thread`.

## Context

The universal search bar is merged (a53dea6cc4): one "Search or add places" bar filters your places and shows
Google cards with ghost pins. The generic embedded conversation view is merged too (d611e19af4,
`conversations/agent-thread`), but no one has run it against a live agent yet. This task adds the third answer of
the bar: **Ask Sonnet**. A natural-language question ("chinese restaurant open tuesday") launches a background
conversation under a `places.ask` scratch profile, in a new Places task category. It works like this:

- The panel shows the conversation as an `<AgentThread>`: user bubbles, live steps, Sonnet's answer, and its picks
  drawn as Google cards with a "why it fits" box. A reply composer lets the user write "cheaper".
- The picks are pinned on the map as numbered violet pins, and your own pins step back.
- While the panel is closed, a pill in the bar shows progress: a spinner and the current step, then "N picks" with
  a dot when unseen.
- "Open conversation" opens the same conversation in the Agent Manager.

Places is agent-thread's first client, so any gap found there is fixed in agent-thread itself.

## Shape

New plugin **`apps/places/plugins/ask`** with `core` and `server`; it has no web part. The Ask UI lives in
**`places-map/web`**, beside the bar it extends. It imports `ask/core`, and `ask` never imports `places-map`. That
keeps `GoogleResultCard` where it is and leaves no import cycle.

### `places/ask/core`

- `PLACES_ASK_PROFILE = "places.ask"` and `PLACES_CATEGORY_ID = "places"`.
- `PlacesAskInputSchema`: the map bounds at launch (`PlaceBounds`), the user's IANA time zone and the launch instant.
  The agent needs the zone and instant to answer "open tuesday" or "tonight".
- `placesPicks = defineThreadResult({ tool: "places_show_picks", schema: { picks: [{ googlePlaceId, why }] (≤ 8) } })`.
- `askCandidates`: a `liveCollection` of the Google candidates this conversation's tools have seen. It filters by
  `conversationId` (required) and carries `placeId` and `candidate: PlaceCandidate`. It is bounded, with a default
  limit of 100 and a `maxLimit` of 200.

  This is where a pick's card data comes from. The result payload stays `{googlePlaceId, why}`, so the agent never
  copies rating or hours, and the card renders from the exact candidate Google returned. The web never makes a
  second Google call.

### `places/ask/server`

- **Table** `places_ask_candidates`, keyed on (conversation_id, place_id), with `candidate jsonb` (parsed) and
  `seen_at`. It is written by upsert from the two tools below and served as `askCandidates`, routed by
  conversation.
- **`TaskCategory({ id: "places", label: "Places", order })`**, following the prototypes and sonata pattern.
- **`ScratchProfile.define(defineScratchProfile({ id: "places.ask", … }))`**:
  - `mcpTools: ["places_search_text", "places_details", "places_show_picks", "flag_raise"]`. It has no
    `exit_clean`, so the agent ends its turn and stays repliable. It has no Bash, and its permissions deny
    Bash, Write and Edit.
  - `instructions(input)` tells the agent:
    - You search Google around this box, read hours and reviews, then call `places_show_picks` once per turn,
      best first, with a one-line *why* that cites the facts it checked ("Open Tue 12:00–22:30 · 4.6★ from 1.2k").
    - Its answer is one or two sentences, because the cards carry the detail.
    - On a reply, re-pick from the earlier candidates and search again only when needed.
- **MCP tools** (`Mcp.tool({ profiles: ["places.ask"] })`), all thin wrappers over places-core and places-api:
  - `places_search_text({ query, maxResults? })` calls the existing `searchPlaces` (`places-core/server`
    `places-repo.ts:62`), biased to the launch bounds (`searchBias`).
    - The rung comes from the server-side ladder (below).
    - It upserts the candidates into the table and returns compact JSON (id, name, rating, ratingCount, price,
      types, address, today's and the asked day's hours).
    - A `maps-not-configured` result is a tool error that tells the agent to stop and say so.
  - `places_details({ googlePlaceId })` calls `placeRichDetails` (reviews and the weekly hours). It updates the
    cached candidate and is budget-checked like search.
  - `places_show_picks` takes `placesPicks.schema` as its input schema. It refuses any id this conversation's
    searches never returned, naming the ids that are allowed, so the agent cannot invent a place.
- **Server-side downgrade ladder.** The client picks the rung today (from the live usage value). A tool has no such
  reader.
  - `google-maps/usage/server` exports `mapsMonthUsageNow()`, the loader `resource.ts` already runs.
  - The tools compute `searchRung((sku) => withinBudget(usage, budgets, sku, now))` with the same core functions, so
    Sonnet can never exceed the free allowance either.

### `places-map/web`: the UI (follows the prototype's `ai: thread`)

- **Ask row** in `UniversalSearchPanel`:
  - "Ask Sonnet “…” · searches Google, reads hours and reviews, picks for you · runs in the background".
  - It sits at the top, highlighted, when the query looks like a question (≥ 3 words or a day/open/near/cheap
    word). Otherwise it sits at the bottom.
  - Enter on the hot row asks; ⌘⏎ always asks.
  - With an empty query, the panel shows three example questions.
- **Starting a run:**
  - The row calls `useStartThread({ profile: "places.ask", categoryId: "places", model: "sonnet" })` with:
    - `title: "Ask: <q>"`
    - `prompt: q`
    - `input: { bounds, timeZone, at }`
  - The returned conversation id becomes the screen's `askConversationId` state.
- **Thread mode:** while `askConversationId` is set, the suggestions panel content is the thread instead of the
  search sections.
  - A frame header holds "✦ Sonnet" and a × that goes back to search.
  - The frame body is `<AgentThread conversationId results={[placesPicks]} renderResult placeholder="Reply to
    Sonnet — e.g. cheaper, open late">`.
  - Editing the bar's text also leaves thread mode, as in the prototype.
- **renderResult:**
  - On the latest turn it draws one `GoogleResultCard` per pick. The card is numbered and gains a `why` variant
    (the violet "why it fits" box in place of the open-now line). It uses the existing Save / Saved and
    hover-link behaviour. Data comes from `useLive(askCandidates, { where: { conversationId } })` joined by
    `placeId`.
  - Older turns render as compact struck-through name chips (`latest: false`).
- **Map:**
  - In thread mode the ghost Google pins are replaced by pick pins: the same `GOOGLE_RESULT_PIN_TYPE` overlay
    with a numbered, violet `ai` look, fed from `useLatestResult(conv, placesPicks)` and the candidates. Hover
    and click link to the cards both ways.
  - Saved-place pins dim while the picks are shown. This is a map-view option, if one exists, or else a tone on
    the Places pin mark. The camera never moves.
- **Pill:** shown when thread mode is on and the panel is closed. Clicking it reopens the panel.
  - It reads `useThreadProgress(conv, [placesPicks])`.
  - While working: a spinner and "step N · <StepLabel of currentStep>".
  - When done: "N picks", with a dot while `unseen`.
- **Restore after a reload:** `useThreadRuns("places.ask", { limit: 1 })`. If its newest run is still working or
  has unseen output, it reopens as the pill. A seen, finished run stays closed, so an old answer never sticks to
  the bar.
- **Step labels** (`AgentThreadSlots.StepLabel`, contributed from places-map web):
  - "Searched Google for “chinese” around this map → 12 places" (the count read from the tool result).
  - "Read hours and reviews of <name>".

### Gaps to fix in shared primitives (found while reading; more expected from the live run)

- **`DataViewSearch`** has no seam for the pill or for ⌘⏎. It gains `adornment?: ReactNode` (trailing, inside the
  field) and `onSubmit?(query, { mod })` (Enter / ⌘⏎ from the field, which today only handles ArrowDown and
  Escape in `search-suggestions.tsx`).
- **`AgentThread`** gets two additions:
  - The view already takes `headerAction`, but `AgentThread` does not expose it. Expose it, so the host's × sits
    in the thread header rather than in a second header.
  - Its words say "N results". Add `resultNoun` ("pick") so the header and host pill read the same.
- **Live verification of agent-thread**, done for the first time by this task:
  - the `mcp__equin__places_show_picks` matching
  - refused picks drawn red
  - an end-turn agent shown `done`, never `failed`
  - resume after hibernate through the composer
  - mark-viewed only while visible
  - "Open conversation" crossing into the Agent Manager from Places (`mode: "push"` → `routeHomeApp`)

  Anything that breaks is fixed in agent-thread with a test over the recorded transcript. The real Places
  transcript is added as a `group-thread.test.ts` fixture.

## Critical files

- New: `plugins/apps/plugins/places/plugins/ask/{core,server}/…` (`index.ts`, `internal/profile.ts`,
  `internal/tools.ts`, `internal/tables.ts`, `internal/candidates.ts`)
- `plugins/apps/plugins/places/plugins/places-map/web/components/{places-screen,universal-search,google-result-card}.tsx`,
  plus new `ask-thread.tsx`, `ask-pill.tsx`, `step-labels.tsx`, and `internal/use-ask.ts`
- `plugins/integrations/plugins/google-maps/plugins/usage/server/{index.ts,internal/resource.ts}`: `mapsMonthUsageNow`
- `plugins/primitives/plugins/data-view/core/internal/types.ts` and `web/components/toolbar/search-suggestions.tsx`:
  `adornment` and `onSubmit`
- `plugins/conversations/plugins/agent-thread/web/components/agent-thread.tsx`: `headerAction` and `resultNoun`

Reused as is: `searchPlaces` and `searchBias` (places-core), `placeRichDetails` and `getPlacesClient`
(google-maps), `searchRung` and `withinBudget`, `useSavePlace`, `GoogleResultCard`, `useStartThread`,
`useThreadProgress`, `useLatestResult` and `useThreadRuns`.

## Verification

1. `./singularity test plugins/apps/plugins/places plugins/conversations/plugins/agent-thread` covers:
   - the tools: the unknown-pick refusal and the rung choice, with a fake client
   - question detection
   - `groupThread` over the recorded Places transcript
2. `./singularity build`, then drive the worktree build with `browser_*`. This makes real Google calls, inside the
   ladder.
   - Ask "chinese restaurant open tuesday". The steps should appear live, then the picks as cards with "why", and
     numbered pins on the map, with the camera unmoved.
   - Close the panel. The pill should show progress, then "N picks •".
   - Reply "cheaper". This gives a second turn, the old picks become chips and the pins update.
   - "Open conversation" should land in the Agent Manager on the same conversation, which is under the Places
     category.
   - Reload mid-run. The pill should come back.
   - Save a pick. It should be auto-tagged, with Undo.
3. Screenshots of each state, then compare them by eye with the prototype at `ai: thread`.
4. Update the track page's status and checklist. File the next task (Sonata migration), not a chain.

## Outcome (as built)

Verified live on the worktree build (two questions, a "cheaper" reply, reload mid-run, Open conversation),
`./singularity test` on both plugins green (151).

Deviations from the plan:

- No `places_details` tool: rich Text Search already carries rating, price and the week's hours (`weekdayDescriptions`),
  and Sonnet cannot read reviews (no atmosphere SKU), so a details call would only add cost.
- Candidates are a `conversations_ext_places_ask` extension row (one jsonb map per run, merged with `||` so parallel
  searches both land), served lookup-only (`places.ask.candidates`, `useLiveRow`) — not a row per place.
- Pick pins are an accent disc with the rank as mark text (a mark can only draw centred text), not an icon + badge.
  Own pins are not dimmed while picks show (no map option for it yet).
- Entering the thread clears the bar's query (the question becomes the thread's first bubble) rather than keeping it,
  because the DataView's query also filters the saved places.

Gaps found in agent-thread by running it live, fixed there:

- The header and fold counted result *calls* ("1 pick" for eight): `defineThreadResult` gains `count(payload)`,
  `resultCountOf` sums it; hosts name the noun (`resultWords`), and `title` / `headerAction` join the header.
- A host that keeps the thread mounted while hidden (a closed popover) had it marked viewed, so `unseen` never showed:
  marking viewed now also needs the thread's box on screen (`useInView`).
- A host's surface may have no run yet: `useThread` / `useThreadProgress` / `useLatestResult` (and
  `useConversation`, `useTranscriptWindow`) take a `null` id.

Pre-existing, not from this change: the search-suggestions popover's content is 24px wider than its box
(`scrollWidth` 408 vs 384) in plain search mode too.
