import type { ReportRow } from "@plugins/reports/server";
import { AdaptiveBarPayloadSchema } from "../../core";
import type { AdaptiveBarPayload } from "../../core";

// Notification re-arm window: a bar in a broken host produces its fault again on
// every mount of that surface — every time the pane is opened, every time the
// toolbar remounts — so this is a recurring warning, not a one-shot crash. The
// bell resurfaces it every 6h rather than collapsing forever onto the first
// sighting. Same policy as optimistic-divergence and render-loop. Lives here
// (not the barrel) per barrel-purity.
export const ADAPTIVE_BAR_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function payloadOf(row: ReportRow): AdaptiveBarPayload {
  // The row's data was validated by AdaptiveBarPayloadSchema at ingest, so this
  // is a total parse; failure would mean a corrupted row, which should surface
  // loudly rather than render a half-empty task.
  return AdaptiveBarPayloadSchema.parse(row.data);
}

export function renderAdaptiveBarTask(row: ReportRow): {
  title: string;
  description: string;
} {
  return { title: renderTitle(row), description: renderDescription(row) };
}

// One headline per fault kind, in the words a human picking the task up needs:
// what the bar found, not what the guard is called. A `Record` keyed on the
// payload union, so a fault kind added to the schema cannot ship without prose.
const HEADLINES: Record<AdaptiveBarPayload["fault"], string> = {
  "no-slack": "adaptive bar was given no slack",
  "nested-bar": "adaptive bar was written inside another adaptive bar",
  "row-overflow": "adaptive bar's fit disagrees with the layout engine",
  "no-convergence": "adaptive bar never converged",
  "iframe-relocation": "adaptive bar refused to relocate an iframe",
  "empty-rung": "adaptive bar widget declared a form it does not render",
};

// What to call this bar in prose. `origin` — the innermost UI-context node above
// the bar's root, e.g. `apps-core.tab-bar@apps.tab-bar` — is the name that
// actually locates it; `label` is the name its consumer gave it, which defaults
// to "More" and is shared by unrelated bars. So the origin leads wherever there
// is one, and the label is the fallback for a page with no lineage to read and
// for every row filed before the field existed.
function barName(data: AdaptiveBarPayload): string {
  return data.origin ?? data.label;
}

function renderTitle(row: ReportRow): string {
  const data = payloadOf(row);
  const noisePrefix = row.noise ? "[noise] " : "";
  const raw = `${noisePrefix}[adaptive-bar] ${HEADLINES[data.fault]} — ${barName(data)}`;
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

// What each fault means, told as: what the bar assumed, what it observed, and
// what it did about it. Everything here is fault-specific; the shared parts (the
// contract, the fix, the report metadata) are appended by renderDescription.
function whatHappened(data: AdaptiveBarPayload): string[] {
  const name = barName(data);
  switch (data.fault) {
    case "no-slack":
      return [
        `The bar **"${name}" was not given any room to give**. It declares itself \`min-w-0 flex-1\` precisely so that \`barRoot.getBoundingClientRect().width\` **is** the available width, with no ancestor walk needed — if that premise holds. It checks rather than assumes: hiding every occupant it currently holds, re-reading the row's own width, and putting them back. A bar that was truly given its width measures the same number either way; this one didn't, so the number it reads is its own content's, not the room it was given. \`flex-grow\` alone would have missed it — it reads \`1\` in the failing case too, because the bar sets \`flex-1\` on itself, which is exactly why that cheaper computed-style check can never catch this. The premise is re-verified whenever the row gets narrower than the width it last verified at, bounded by a small probe budget, so this can be reported long after the bar's first laid-out pass — naming a host that broke later, not only one that was wrong from mount.`,
        `There is a second way in, and a report from it says so in its own message: a row that measures **0px while occupants are relocated out of it**. That reading has two possible causes and cannot be told apart by width alone — a host that shrink-wraps to the bar (the ratchet, at its end), or a row so **over-full** that the bar's \`flex: 1 1 0%\` cell has negative free space and no basis to absorb a share of it, resolving to 0px while perfectly healthy. So the bar re-admits every occupant and re-asks the probe, which can answer it; a report arrives only when the re-ask was tried a bounded number of times and never produced a judgeable width.`,
        `That false premise would otherwise poison everything downstream: a bar reading a shrink-to-content box's own width always "fits" whatever is docked in it, so it would never compact and never relocate no matter how crowded the row its host actually gives it is — the row would simply spill out of its parent, or, in a parent that clips, occupants would silently disappear with no report at all.`,
      ];
    case "nested-bar":
      return [
        `The bar **"${name}" is written inside another adaptive bar's occupant**, and **one adaptive bar per row** is the primitive's contract (\`plugins/primitives/plugins/adaptive-bar/CLAUDE.md\`). It is not a style preference: a bar declares itself \`min-w-0 flex-1\` and asks the chain above it to grow, precisely so that \`barRoot.getBoundingClientRect().width\` **is** the room it was given. Two bars in one row are two claimants on the same slack — the inner one takes all of it, and the outer one is left measuring its own content.`,
        `The visible damage is usually filed against the wrong bar. The outer bar's width now moves with its own content, so **it** reports \`no-slack\` and stops deciding, naming a host that is perfectly fine; meanwhile its yielding cell (a pane title, typically) gets nothing and crushes to its first word, and its \`⋯\` never collapses anything because everything "fits" a box that grows to hold it. This fault names the actual offender, at the moment it mounts, rather than leaving the reader to work backwards from the other bar's report.`,
        `An \`AdaptiveBar.Collapsed\` nested inside a bar is **not** this and never files it: it is one \`shrink-0\` \`⋯\` sitting among the row's occupants, it measures nothing and asks for no slack — which is how \`reorder\`'s \`overflow\` node type renders an authored bucket inside a pane header. Only a MEASURING bar is a second claimant.`,
      ];
    case "row-overflow":
      return [
        `The bar **"${name}" blessed a row that then did not fit**. On a converged pass — the placement stopped changing, so what is rendered *is* what the fit decided — the fit reported \`fits: true\`, and the union of the occupants' own rendered boxes still stuck out of the bar's own content box, on one side or the other. Those two statements cannot both be true, so one of the widths the fit decided from is not a width this row actually has.`,
        `That is a genuine contradiction rather than a cramped row: overflow alone is handled structurally (the bar clips or scrolls by CSS) and is never reported. The usual causes are a widget whose rendered width does not match what it measured at that rung (an async font, a late-loading icon, a transition mid-flight), or a bar hosted somewhere its width reading does not describe — the same premise the \`no-slack\` guard covers, seen from the other end.`,
      ];
    case "no-convergence":
      return [
        `The bar **"${name}" could not settle**. Each measure→decide round produced a different placement, and the bar ran out of rounds before the answer stopped moving. The fit is deliberately current-state-independent apart from pins and hysteresis, so a set of widths that holds still converges in at most a few passes — which is why the bar counts rounds only while its premise (the row's own width, the set of occupants, and each occupant's width at the rung it is already sitting at) holds still, and counts a moved premise separately.`,
        `**The evidence below says which of those happened**, so this does not have to be reproduced. An occupant whose own rendered width moved at an unchanged rung is the usual culprit and is named there; a row whose width kept moving is the page resizing under the bar; and neither of those with a repeated placement is a cycle in the fit itself.`,
      ];
    case "iframe-relocation":
      return [
        `The bar **"${name}" left an occupant in the row that it wanted to move out**. That occupant contains an \`<iframe>\`, and this browser has no state-preserving \`moveBefore()\` — so re-parenting it into the overflow panel would tear the frame down and **reload it**, losing whatever is inside.`,
        `The bar refused, deliberately: silently reloading a user's embedded content is worse than a row that stays wider than it wanted to be. This is the one fault the *browser* causes rather than the consumer — nothing in the host's layout is wrong, and the report exists so the trade-off is visible instead of mysterious. It resolves by itself on any engine that ships \`moveBefore()\`.`,
      ];
    case "empty-rung":
      return [
        data.item === undefined
          ? `An occupant of the bar **"${name}" declared a smaller form and then rendered nothing as it**. \`useActionForm({ shrinksTo: ["compact"] })\` is a promise that the widget can render ITSELF as compact; this one returned no DOM at all when it was asked to. The message below names the occupant and the form.`
          : `The bar occupant **\`${data.item.id}\`** (in the bar **"${name}"**) **declared a \`"${data.item.form}"\` form and then rendered nothing as it**. \`useActionForm({ shrinksTo: [...] })\` is a promise that the widget can render ITSELF in that form; this one returned no DOM at all when it was asked to.`,
        `Vanishing is the one transformation this primitive exists to prevent — the whole design is relocation, not transformation, so a control that disappears instead of shrinking is worse than a cramped row. It is also, until now, how the bar could be made to flip for ever: an occupant that rendered nothing was read as "not an occupant", dropped from the placement, read back as "never placed", rendered its full form, and demoted again. This is the contributor-side half of that fix, and the only fault the **contributor** causes rather than the host or the browser.`,
      ];
  }
}

// The half the two stopping faults share: committing and stopping are one act,
// and the floor never buries occupants a `clip` bar could not get back. Declared
// before its two readers, so nothing depends on hoisting.
const stopsDeciding = `It then **stopped re-deciding at that width** — committing and stopping are one act, because a bar that keeps re-deriving through a fault recomputes the same answer, trips the same guard and commits again forever (a render loop, which is what took the Layout Lab pane down). A genuine resize re-arms it, since that is a premise it has not failed under, up to a small cap per mount — so a *transient* fault costs one cramped render rather than a toolbar parked until the pane is reopened. Eviction is part of the floor **only in \`panel\` mode**, where an evicted occupant is still reachable behind the \`⋯\`; under \`scroll\` and \`clip\` the floor keeps every occupant inline, because dropping them into the hidden parking dock would hide the whole bar. Items that mount or unmount afterwards are placed against the committed answer. The user sees a **usable, possibly cramped** bar — not a broken pane.`;

// What the bar did with the row after the fault — the part that explains what a
// user is looking at right now. Two of the six stop the bar deciding at a width
// and re-arm on a resize, and they no longer do the same thing when they stop,
// so they no longer share a paragraph: `row-overflow` has had its own arithmetic contradicted and can
// vouch for nothing it computed, while `no-convergence` merely ran out of rounds
// and usually produced perfectly good answers along the way.
function whatTheBarDid(data: AdaptiveBarPayload): string {
  switch (data.fault) {
    case "no-slack":
      return `It **stopped deciding, for good**: every occupant went back into the row at its widest form, and whatever does not fit is left for CSS to clip. That is the **ceiling** rather than the floor \`row-overflow\` takes — an eviction is precisely what a bad width reading was already producing, so pulling more occupants out of the row is the one direction that cannot make a lying number more honest. Unlike \`row-overflow\` and \`no-convergence\`, there is no re-arm on resize: once the width reading has been shown untrustworthy, nothing about the row's own size can restore trust in it, so the bar keeps clipping for the rest of this mount.\n\n**Unless the message above says nothing was latched.** A bar whose row is merely over-full reports and commits nothing: it re-admitted every occupant, found the 0px was never its own doing, and goes back to deciding the moment the row has room. Nothing is stuck — but at 0px everything the bar holds is clipped to invisibility, which is why it is worth saying.`;
    case "nested-bar":
      return `The **inner** bar — this one — **stopped deciding, for good**: every occupant went back into the row at its widest form, and whatever does not fit is left for CSS to clip. That is the same **ceiling** \`no-slack\` takes, for the same reason: a bar inside another bar's occupant sits in a \`shrink-0\` container, so every width it reads is its own content's, and evicting on a lying number is exactly the damage. The **outer** bar is untouched by this and keeps whatever it decided — which, while the nesting lasts, is usually "everything fits", since its width grew to hold whatever the inner bar wanted.`;
    case "row-overflow":
      return `It committed the **floor layout**: every unpinned occupant at its narrowest rung, and — in \`panel\` mode only — everything that can leave the row moved into the overflow panel. The floor unconditionally, because the claim under suspicion here is precisely "the widest placement the fit blessed as fitting": the engine has just contradicted the fit's own numbers, so there is no placement of this search left to trust. ${stopsDeciding}`;
    case "no-convergence":
      return `It committed **the widest placement this search had measured as fitting** at this width, if it produced one — that placement carries the same "it fits" claim as the floor, by the same arithmetic, from measurements rather than estimates, and it is strictly wider, so throwing it away would cost the user their whole toolbar over a fault that is frequently transient. The width test is not decoration: a placement that fitted at 900px says nothing at 400px, so where the search produced no such placement *at this width* the bar falls back to the **floor** — every unpinned occupant at its narrowest rung. ${stopsDeciding}`;
    case "iframe-relocation":
      return `It pinned that occupant inline for good and re-fitted everything else around it. The row may therefore be wider than the bar would otherwise have allowed, and other occupants may have been relocated in its place.`;
    case "empty-rung":
      return `It **stopped offering that form** to that occupant: the ladder the fit sees is now cut short there, so the widget stays at its widest form and leaves the row (into the \`⋯\` panel, where it renders as itself) when the row runs out of room. Nothing else is affected, and the bar keeps deciding normally. The form is offered again as soon as the widget is observed to render differently — so fixing the widget needs no restart, and the fix is to render something as that form, or to stop declaring it.`;
  }
}

// The evidence the bar recorded for a `no-convergence`, written as the finding
// it is rather than a table: which occupant's width moved, whether the row
// itself held still while it did, how the three counters ran out, and whether a
// placement came back. Between them those four answer "what do I fix", which is
// the whole reason a transient fault records anything at all.
//
// Only ever called for `no-convergence`, and only when the row has evidence:
// rows filed before the bar recorded rounds have none, and every renderer has to
// survive that (the parse is total, so a missing field is a legal row and not a
// corrupt one).
function evidenceLines(
  evidence: NonNullable<AdaptiveBarPayload["evidence"]>,
): string[] {
  const lines: string[] = [];

  // The row's own width first, because it decides who is on trial. One width
  // means the row held still while the placement kept changing, which puts the
  // blame inside the bar; several mean the page was resizing under it, and a
  // bar re-deciding through a resize is not misbehaving. The empty arm is not
  // decoration: an episode whose round ring is empty recorded no width, and
  // printing "the row held 0px" for it would be a claim the bar never made.
  const first = evidence.widths[0];
  lines.push(
    evidence.widths.length > 1
      ? `- **The row itself moved** — it decided from ${evidence.widths.map((w) => `${String(w)}px`).join(" → ")}. The page was resizing under the bar, so some of these rounds were answering different questions.`
      : first === undefined
        ? `- **No row width was recorded** for this episode, so nothing here can say whether the row held still.`
        : `- **The row held ${String(first)}px throughout**, so the placement kept changing while the width it was decided from did not.`,
  );

  // The named occupants: nothing the search did explains a width that moved at a
  // rung the item was already sitting at, so these are the ones to open first.
  if (evidence.moved.length > 0) {
    for (const m of evidence.moved) {
      lines.push(
        `- **\`${m.id}\` resized itself**: ${String(m.from)}px → ${String(m.to)}px at rung ${String(m.rung)} — the same rung both times. Nothing the fit did explains that, so the rounds before it were deciding from a width that had already changed.`,
      );
    }
  } else if (evidence.cycled) {
    lines.push(
      `- **No occupant resized itself**, and a placement the search had already produced came back. That is a cycle in the fit itself rather than a moving premise — the one case where the search is the thing at fault.`,
    );
  } else {
    lines.push(
      `- **No occupant resized itself at an unchanged rung**, and no placement repeated. The search simply needed more rounds than its budget allowed.`,
    );
  }
  if (evidence.moved.length > 0 && evidence.cycled) {
    lines.push(
      `- A placement the search had already produced also came back, so the moving widths were driving it around a loop.`,
    );
  }

  // The counters last: they say which bound tripped, which is what distinguishes
  // "the fit would not settle" from "the widths never stopped moving" from "this
  // bar has never settled at all".
  lines.push(
    `- **Counters** — ${String(evidence.rounds)} round(s) at a premise that held still, ${String(evidence.shifts)} premise move(s) without ever settling, ${String(evidence.total)} round(s) since the last settled answer (that last one is the counter nothing resets, and the reason tolerating a moving premise is bounded rather than infinite).`,
  );
  return lines;
}

function howToFix(data: AdaptiveBarPayload): string[] {
  const findTheBar =
    data.origin === undefined
      ? `Find the \`<AdaptiveBar label="${data.label}">\` (or \`<AdaptiveBar.Collapsed label="${data.label}">\`) — with no lineage recorded for this bar, the label is the only name there is, and it is authored at the call site.`
      : `Find the bar: it sits under \`${data.origin}\` — the innermost UI-context node above its root, so the plugin named there is the one that composed it — with the label \`"${data.label}"\`. Grep the label second, not first: it defaults to \`"More"\`, so it may not be written at the call site at all.`;
  switch (data.fault) {
    case "no-slack":
      return [
        findTheBar,
        `Then satisfy the one rule for consumers (\`plugins/primitives/plugins/adaptive-bar/CLAUDE.md\`): **put the bar where there is slack to give** — as the growing cell of a single-line row (\`Line\` / \`Row\` / \`Bar\`), with **no \`Fill\` or other \`flex-1\` sibling** competing for the same slack, and **never inside a shrink-to-content parent** (\`inline-flex\`, \`w-fit\`, \`Cluster\`). One adaptive bar per row. In practice it is almost always one of three things: a \`Fill\` next to the bar that should be deleted (the bar *is* the fill), a \`Cluster\`/\`Inline\` wrapper around it that should be a \`Line\`, or a second bar in the same row.`,
        `If the message says the bar re-admitted its occupants and still could not get a judgeable width, check the bar's **siblings** as well as its ancestors: a row whose other cells over-fill it leaves the bar's \`flex: 1 1 0%\` cell nothing to resolve to, and the fix there is to make one of those siblings shrinkable (\`min-w-0\`, or a truncating leaf) rather than to move the bar.`,
      ];
    case "nested-bar":
      return [
        findTheBar,
        `**Delete the inner bar.** Its occupants become ordinary children of the widget — a plain \`Stack\`/\`Line\` row — and the OUTER bar's \`⋯\` collapses them when the row runs out of room, which is the behaviour the inner bar was hand-rolling for a row that already had it. If the widget was relying on its own per-occupant ladders (\`useActionForm\` inside it), note that a group under ONE bar item shares one channel: declare the ladder once, for the widget as a whole, or promote the pieces to separate contributions of the outer bar so each gets its own.`,
        `If the occupants genuinely belong behind a \`⋯\` of their own — an authored bucket rather than an overflow — that is \`<AdaptiveBar.Collapsed>\`, which is legitimate here and files nothing: it measures nothing and takes no slack. Reach for it only when the answer really is "these live behind a ⋯ whatever the width", never as a way to silence this fault.`,
      ];
    case "row-overflow":
      return [
        findTheBar,
        `First re-check the host against the one rule for consumers (see \`plugins/primitives/plugins/adaptive-bar/CLAUDE.md\`): the bar must be the growing cell of a single-line row, with no \`Fill\`/\`flex-1\` sibling and no shrink-to-content ancestor. If the host is right, the disagreement is in an occupant: look for one whose rendered width differs from what it measured — content that arrives after the measurement (an icon font, a lazily-loaded label, a number that grows), a CSS transition on a bar item (never animate one; animate the panel), or a \`position: sticky\` inside an item, which is unsupported. Reproduce it in the layout-geometry harness (\`./equin check layout-geometry\`) rather than by eye — the guard only runs when a real layout engine answered.`,
      ];
    case "no-convergence":
      return [
        findTheBar,
        data.evidence !== undefined && data.evidence.moved.length > 0
          ? `**Start with the occupant the evidence names** (\`${data.evidence.moved[0]?.id ?? ""}\`): its own rendered width moved between two rounds at a rung it was already sitting at, so it is resizing itself for a reason that has nothing to do with the fit. The usual sources are content arriving late (an icon font, a lazily-loaded label, a number that grows), a CSS transition on a bar item (never animate one — animate the panel), or the item's own measuring layout effect re-measuring whenever its parent re-renders. That is a fix in the occupant, not in the bar.`
          : `The evidence names no self-resizing occupant, so widen the search below.`,
        `Then look for an occupant whose width is not a function of its rung alone. Render each of that bar's items at each declared form and compare the measured widths: a compact form that is not narrower than the form above it is the classic offender, and so is any item that animates, or that reflows its own content in response to being resized. If every item measures monotonically, the next suspect is the host — a parent whose own width responds to the bar's (a shrink-to-content ancestor, or a sibling that grows as the bar shrinks) closes the same feedback loop from outside.`,
      ];
    case "iframe-relocation":
      return [
        findTheBar,
        `There is nothing to fix in the bar. Decide whether that occupant belongs in an adaptive bar at all: an \`<iframe>\` is the one payload that cannot survive a fallback re-parent, so if it must be in the row, it will simply stay there on engines without \`moveBefore()\`. If the row is now too crowded because of it, give that surface fewer bar occupants, or host the frame outside the bar.`,
      ];
    case "empty-rung":
      return [
        data.item === undefined
          ? `**The fix is in the occupant, not in the bar** — the message above names it and the form it vanished at. Open that widget and find the branch that returns \`null\` (or renders nothing) when \`useActionForm()\` hands it that form.`
          : `**The fix is in the occupant, not in the bar.** Grep for the \`<AdaptiveBar.Item id="${data.item.id}">\` (or the contribution whose id that is), open the widget inside it, and find the branch that returns \`null\` — or renders nothing — when \`useActionForm()\` hands it \`"${data.item.form}"\`.`,
        `Then pick one of two. Either **render something as that form** — an icon-only button, a count without its label, whatever the smaller version of this control is; that is what the ladder promised. Or **stop declaring it**: drop it from \`shrinksTo\`, and the bar will relocate the widget into the \`⋯\` panel instead, where it renders as itself. Do not "fix" it by leaving the declaration and rendering an empty box — a zero-width occupant still pays for a gap, and the control is still invisible.`,
        `One special case is worth checking first: a widget that renders nothing **at every form** (an empty list, data that has not arrived) is ordinary and is never reported. If this one is really in that state, the branch to fix is the one that made the widest form render while a narrower one did not.`,
      ];
  }
}

function renderDescription(row: ReportRow): string {
  const data = payloadOf(row);
  const lines: string[] = [];

  lines.push(...whatHappened(data));
  lines.push("");
  lines.push(`**The primitive's own words**`);
  lines.push(`> ${data.message}`);
  lines.push("");
  // The rounds, where there were any. Sits before "what the bar did" because it
  // is the finding, and what the bar did is the consequence.
  if (data.evidence !== undefined) {
    lines.push(`**What the rounds showed**`);
    lines.push(...evidenceLines(data.evidence));
    lines.push("");
  }
  lines.push(`**What the bar did about it**`);
  lines.push(whatTheBarDid(data));
  lines.push("");
  lines.push(`**Fault**`);
  lines.push(`- **Kind:** \`${data.fault}\``);
  lines.push(`- **Bar:** \`${data.label}\``);
  // `origin` is the identity the report is deduped on; `originPath` is the full
  // lineage, per-instance region ids and all, which is what says WHICH pane or
  // tab this bar was in. Both are optional: a page with no UI-context lineage
  // has neither, and rows filed before the fields existed have neither stored.
  if (data.origin !== undefined) lines.push(`- **Origin:** \`${data.origin}\``);
  if (data.originPath !== undefined) {
    lines.push(`- **Lineage:** \`${data.originPath}\``);
  }
  if (data.overflow !== undefined) {
    lines.push(`- **Overflow mode:** \`${data.overflow}\``);
  }
  lines.push("");
  lines.push(`**Report**`);
  lines.push(`- **Source:** ${row.source}`);
  lines.push(`- **Worktree:** ${row.worktree}`);
  lines.push(`- **Fingerprint:** ${row.fingerprint}`);
  lines.push(`- **Count:** ${row.count}`);
  lines.push(`- **First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`- **Last seen:** ${row.lastSeenAt.toISOString()}`);
  if (row.url) lines.push(`- **URL:** ${row.url}`);
  if (row.userAgent) lines.push(`- **User-Agent:** ${row.userAgent}`);
  lines.push("");
  lines.push(`**How to fix**`);
  lines.push(...howToFix(data));
  return lines.join("\n");
}
