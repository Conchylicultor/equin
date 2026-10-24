# Website: the Improve button

## Context

The equin website sells an idea: apps that improve themselves, with agents. Right
now the site only talks about it. The header's one call to action is "Get in
touch", an email link.

This change replaces it with an **Improve** button that lets a visitor try the
real gesture. The visitor describes a change to the page. The site then plays a
short, clearly labelled replay of what equin would do with it: file a task, make
a copy of the app, have an agent edit it, run checks, then deploy or ask for
review. Finally the visitor can file the idea as a prefilled GitHub issue.

No agent runs on the public site. It has no backend for this, and the website
build deliberately leaves out the agent and task plugins (the `website`
composition excludes `agent-runtime` and `auth`). So GitHub is the honest place
the idea lands.

The approved mock is prototype `proto-1788797350-gqju`, with theme = launch and
improve = replay. The live site is the dark Launch look.

**Out of scope, filed separately** as task `task-1789122717775-lj8anm`: "Point at
the part you mean", meaning the element picker and the smart `<ui-context/>`
chip. That needs the picker and chip moved out of `improve/element-picker` and
`active-data`'s page-editor edge fixed first. This plan leaves room for it: the
text field is already the real Lexical editor, so that task only has to add the
picker button and the chip.

## Decisions (from the user)

- Submitting plays the replay first. **Filing is always an explicit click**, on
  "File it". Nothing opens GitHub automatically.
- "File it" is **enabled from the first frame of the replay**, so a visitor can
  skip the replay.
- The deploy option is a **Switch**, not a checkbox (the design system draws
  on/off settings as switches). It is labelled so it is obvious the change ships
  **without a human looking at it first**: label **"Auto-deploy"**, hint
  **"Ships as soon as checks pass, no review"**.
- Footer: the **email and GitHub icon** move into the site footer. The X icon is
  not added, because there is no handle yet. The contact band keeps its two
  cards. The footer keeps the wordmark on the left.
- The "Get in touch" header pill is removed. The header is left with the
  destinations plus Improve.

## Design

### New plugin: `plugins/apps/plugins/website/plugins/improve/`

It is a sibling of `shell`, `landing`, `questions` and `story`. Improve is
site-wide chrome, worn on every page, so it does not belong to one page.

It imports only `apps/website/shell` and generic primitives. That keeps the
website build free of tasks, conversations and auth.

- `core/issue-url.ts`: `buildIssueUrl({ repoUrl, text, pageUrl, autoDeploy })`
  returns `<repo>/issues/new?title=…&body=…&labels=idea`.
  - Title: the first non-empty line, cut at 72 characters with "…".
  - Body: the text, a `---` rule, `Page: <url>`, `Auto-deploy: yes / no (review
    first)`, and "Filed from the Improve button on equin.ai".
  - Length: the text is truncated so the whole URL stays under ~7,500 characters
    (GitHub rejects longer URLs).
  - Pure function, with `core/issue-url.test.ts` next to it. Also exported:
    `issueTitle` (used by the test).
- `web/components/improve-nav-item.tsx`: the header button.
  - A `WebsiteNavLink` with `emphasis="strong"` and a sparkle icon, used as the
    trigger of an `InlinePopover` (`primitives/overlay/plugins/popover`) with
    `align="end"` and a fixed `width` role (≈ `md`).
  - Open state is styled from base-ui's `data-popup-open` (accent fill, as in
    the mock).
- `web/components/improve-panel.tsx`: the popover body. A two-state view,
  `compose | replay`, as a discriminated union in local state. The draft text
  survives while the popover is closed and reopened.
  - **Compose**, top to bottom:
    - Title "Improve this page".
    - One muted line: "Say what you'd change, and an agent builds it in its own
      copy of the app while you keep working."
    - `TextEditor` (`primitives/text-editor`): `minRows 4`, `autoFocus`,
      `submitMode "cmd-enter"`, `onSubmit` starts the replay, placeholder "e.g.
      Show a 20-second demo under the headline".
    - A footer line: the `Switch` (`primitives/css/plugins/switch`) with its
      label and hint on the left, and the primary "Show me" button on the right.
      The button is disabled while the text is empty.
  - **Replay**: header "What equin would do now" plus a "Replay" `badge`, and
    the muted line "Scripted and sped up. A real run takes a few minutes."
    Below that, the step list. Then the footer: the muted note "No agent runs
    here, so your idea goes to GitHub." and **File it**.
  - **File it** is a real `<a href={buildIssueUrl(…)} target="_blank"
    rel="noopener noreferrer">`, rendered through `Button render={…}`. It is
    enabled as soon as the replay view shows. Its `onClick` closes the popover
    and clears the draft; the browser opens the tab itself.
- `web/components/replay-steps.tsx`: the scripted steps. They are a fixed
  script, not domain records, so this is not a DataView. The step list is
  annotated if the `no-adhoc-row-list` lint trips.
  1. **Task filed**: the visitor's first line, quoted and truncated.
  2. **Its own copy of the app**: "Branched from main as `improve-xxxx`". The id
     is 4 random base-36 characters, drawn once per replay.
  3. **An agent makes the change**: "Finds the code behind this page and edits
     it". The follow-up task can name the picked element's source file here.
  4. **Checks pass**: "Types, plugin boundaries and tests". No numbers.
  5. The last step depends on Auto-deploy:
     - Off: **Preview is live**, "At `improve-xxxx`, beside the real page", with
       disabled "Open preview" / "Merge & deploy" / "Send back" buttons.
     - On: **Merged & deployed**, "Shipped as soon as checks passed".
  - How the steps advance: each step is pending, then active, then done. The
    active step renders a spinner (`css/plugins/spinner`) and a CSS progress
    animation lasting that step's duration. The animation's `onAnimationEnd`
    moves to the next step. So the sequence is event-driven, with no
    `setTimeout` chain.
  - Reduced motion: under `prefers-reduced-motion`, read once when the replay
    starts, every step is shown done immediately.
- `web/index.ts`: contributes `WebsiteHeader({ id: "improve", component:
  ImproveNavItem })`.
- `CLAUDE.md`: what the button does and what it does not do. The "no agent runs
  here" line explains why this is not a form that posts anywhere (see the
  contact rule below).
- `e2e/improve-verify.ts`: see Verification.

### Shell (`plugins/apps/plugins/website/plugins/shell/`)

- `core/site.ts`: move `CONTACT_EMAIL` / `CONTACT_MAILTO` here from
  `landing/contact/web/internal/contact.ts`. The address becomes a site-level
  fact like `SOURCE_URL`, because the footer (shell) now needs it too. Contact
  imports it from `shell/core`, and the old file is deleted.
- `web/components/website-footer.tsx`: the wordmark stays at the leading edge.
  The trailing edge gets the email (a real `mailto:` link, muted) and the GitHub
  icon link (the round outlined `SiGithub` link currently in the contact band).
  Use a `Line` with the two ends, a composed primitive, no hand-rolled flex. It
  stacks or wraps on phones.
- `web/components/website-nav-link.tsx`:
  - Add an optional `icon` prop, for Improve's sparkle.
  - Reword the doc. `strong` now means "the header's one call to action", not
    "the one entry that leaves the site".

### Contact (`plugins/apps/plugins/website/plugins/landing/plugins/contact/`)

- Delete `web/components/contact-nav-item.tsx` and the `WebsiteHeader`
  contribution.
- `contact-section.tsx`: drop the trailing GitHub + email `Inline` row. The two
  cards stay exactly as they are.
- Update the description and CLAUDE.md. The band is now two cards, and the
  header item and links are gone. Keep "Do not add a form"; Improve is not a
  form, it hands off to GitHub.

### Config

`config/apps/website/shell/header.jsonc`: replace
`"apps.website.landing.contact:contact"` with
`"apps.website.improve:improve"`, in the same last position. Update the comment
("last, the header's one call to action").

## Risks

- **GitHub's `labels=` parameter** is ignored for visitors who lack triage
  rights on the repo. The issue files fine, just unlabelled. A repo issue
  template could apply the label instead. Not part of this change; flagged only.
- **Global editor extensions.** `TextEditor` reads a page-wide registry of token
  types. The website build includes no plugin that registers any, so the field
  is plain text. The follow-up task will add exactly the chip.
- **Breaking the website build.** Improve must not import anything from
  `tasks`, `improve` or `active-data`. The `composition-closure` check fails if
  it does (see Verification).

## Verification

1. `./equin test plugins/apps/plugins/website/plugins/improve`: tests for
   `buildIssueUrl`:
   - title from the first line and its truncation;
   - the body contains the page URL and the auto-deploy choice;
   - the URL length stays within the cap for very long text;
   - special characters are encoded.
2. `./equin check composition-closure` and `./equin check
   plugin-boundaries`: the website build still leaves out tasks,
   conversations, auth and the page editor.
3. `./equin build`, then
   `./equin run plugins/apps/plugins/website/plugins/improve/e2e/improve-verify.ts`
   on `/website`. The script checks:
   - The header shows Improve and no "Get in touch". The footer shows the email
     and the GitHub link. The contact band still has two cards and no link row.
   - Opening the popover focuses the field, and "Show me" is disabled until
     there is text.
   - After Show me, **File it is enabled immediately**, before step 2 finishes.
     Its `href` is `…/issues/new?` with the typed title and a body holding the
     page URL. It never opens a tab by itself (no popup event before the click).
   - The steps reach done. The last step reads "Preview is live" with Auto-deploy
     off and "Merged & deployed" with it on.
   - ⌘↵ in the field starts the replay.
   - It takes screenshots at 1280 px and 420 px.
4. `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts
   --name proto-1788797350-gqju --options theme=launch,improve=replay`. This
   compares the page at rest against the mock. The header and footer are
   expected to differ where the decisions above changed the mock (no Contact
   link, no X icon).
