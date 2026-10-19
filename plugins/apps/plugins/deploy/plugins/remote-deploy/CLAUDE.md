# remote-deploy

**One button** that puts a new version of one composition on its server. Design:
[`research/2026-08-05-global-deploy-pane-test-locally-and-one-button-deploy.md`](../../../../../../research/2026-08-05-global-deploy-pane-test-locally-and-one-button-deploy.md)
(Phase A). Supersedes the four-step Converge → Build → Rehearse → Ship surface of
[`2026-08-03-global-deploy-release-candidate-pipeline.md`](../../../../../../research/2026-08-03-global-deploy-release-candidate-pipeline.md).

This plugin contributes `deploy` + `output` into `DeploymentDetail.Section` and
`release` as a client field of the `deployments` collection
(`releaseFields`, core; resolved by `ReleaseFieldResolver`, web). It owns **no** sequencing: pressing Deploy
POSTs `{ verb: "update" }` and everything after that is the `deployments`
sibling's server-side orchestrator.

## Why the four steps collapsed into one

The pipeline was a faithful rendering of a real constraint chain — `ship` refuses
on an un-converged host, and refuses without a packed, platform-matched bundle. It
*exposed* the chain because at the time nothing sequenced it. Two facts made it
automatable:

1. **Converge is genuinely a no-op the second time.** Every file write goes
   through a content-comparing `put` and the unit restart is gated on the running
   process predating its configuration, so running it before every ship costs a
   warm host nothing and repairs drift on a cold one.
2. **The bundle question already had one authority.** `resolveBundle` +
   `compareToHead` answer *"is there a shippable bundle for this (composition,
   platform), and was it built from clean HEAD"* — so "do I need to build?" is a
   computed answer, not a question to ask the user.

The steps did not disappear; they became the **phases of one run**, reported as
they happen. `Steps`/`Step` is still what renders them, now purely as a **report**
— nothing inside a step is clickable, because the sequence belongs to the server.
A failed run leaves `phase` at the leg it died on, which is what makes the strip
worth keeping on screen after the run ends.

**The ship confirm dialog is gone.** It existed to make *"you never rehearsed
this"* deliberate. A confirm on the app's one primary action is friction, not
safety; `ship`'s remote health gate and its automatic revert are the real
protection and are untouched.

## Nothing here re-derives shippability

The `release.candidate` live value carries the exact `BundleResolution` that
`./singularity deploy ship` acts on; refusals render through
`bundleRefusalMessage()` **verbatim**. The platform is never a picker — it comes
from the server's health probe, the same argument that keeps `runUser` derived.
The copy of it read here only *labels* the button: the orchestrator reads the
same fact server-side, so no client can name a platform.

A refusal is **not** a blocker for the button. Deploy builds what is missing, so
the refusal is rendered as *what Deploy would have to start from*, not as a wall.

## Two questions, gated together

`useReleaseInfo` asks both live — no tick, no refetch — and answers with a
`ResourceResult<ReleaseSnapshot>`, so "no bundle", "not asked yet", "cannot
ask" and "asking failed" never render alike: `loading`, `error` (a corrupt
`RELEASE.json` is the candidate's error, not a refusal), and a ready snapshot
that is either `no-platform` (the server reported none, so there is no
candidate question) or `resolved` (`state` derived once by
`resolveReleaseState`). It is derived only through the sanctioned combinators
(`mapResource`, `combineResources`, `foldResource`); the ordering gate below is
one more gate input to the combine. `releaseStateOf(info)` is what the Release
column's `value` reads. The chip and the pane render every state.

- **filesystem** — `useLive(releaseCandidate, { composition, platform })`;
- **DB** — `useLive(releaseHistory, { where: { composition }, orderBy:
  startedAt desc, limit: 1 })`, the newest run of that composition, the only way
  to know a build is running or that the last one failed. The engine's in-flight
  uniqueness is `(namespace, composition)`, so a staged Studio run really does
  block a candidate build here.

Nothing orders the two streams, so the newest run can arrive before the
candidate it produced. `candidatePredatesLatest` (core) holds `loading` only
while that lag is PROVABLE — the run is a succeeded web `candidate` of this
platform, and the candidate either resolved an older run built before it
started, or found no pointer and was observed (`observedAt`) before it
finished. Anything else (another platform, a staged or failed run, a hand-run
CLI release, any other refusal) renders as it stands, so the gate cannot stay
shut. `release-info-live-verify` drives it end to end.

## The Output tab follows the phase

An `update`'s middle leg writes to the `release` channel while the two around it
write to `deploy`. A fixed tab would therefore go silent for the longest part of
the run, and the user would need to know the channel topology to find the output.
So the switcher's active tab follows `DeployRun.phase` **until the user picks a
tab by hand** — after which the choice is theirs for the rest of the mount.

## The inspect links

`publicUrls(deployment.hostnames)` from `deployments/core/derive.ts` — the
declared owner of remote-host facts — mirrors what the CLI prints at the end of a
successful ship. A deployment with no hostname renders `loopbackOnlySentence()`
instead of nothing: "no public URL" is an answer about the deployment, and a
blank region answers it by implication.

## The `Release` column states what Deploy would pick up

```
building → failed (ONLY when no bundle exists at all) → none
→ platform-mismatch → stale → built
```

A build that failed while a good bundle still exists does **not** read `failed` —
ship would still pick the older bundle, so the failure belongs on the run, where
the log is. `unknown` staleness (dirty build / absent sha) is **not** `stale`:
unprovable is not out-of-date, and in an active worktree most candidates read
unknown.

It reaches the list as a `clientFields(deployments, "release", …)` declaration
(`ClientFields.Resolve`), so `deployments` never names this feature. The
resolver mounts once per surface but the answer is per
`(composition, platform)` — hence one headless `CandidateProbe` per row folding
into a map that `value` reads synchronously, so filter/group/sort agree with the
chips instead of trailing them by a render.

The resolver is handed the list's rows (they carry `serverId`), so it probes
exactly the rows the list shows; the `release` cell (`ReleaseCell`) reads the
probed infos the resolver publishes around the list, since a cell is handed only
the field's value (the state), not the snapshot the chip also draws.

## What this still does not claim

Nothing local ever runs the bytes that ship (a `linux-x64` binary cannot execute
on this host). The **Test locally** section above it
([`local-serve`](../local-serve/CLAUDE.md)) serves the composition's namespace on
the shared gateway, which checks composition membership and closure — not the
packed artifact. The only thing that exercises the artifact is `ship`'s own
remote health gate.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Deploy one composition to its remote server: a single Deploy button launching the `update` sequence (converge → build a platform-pinned candidate unless one is already current → ship that pinned run id), the three-phase report of the running deploy, what is currently built and how it relates to HEAD, the public URLs to inspect the deployed app, the phase-following deploy/build log output section, and the `Release` client field (`releaseFields`) of the deployments list.
- Web:
  - Contributes:
    - `DeploymentDetail.Section` "Deploy to server" → `RemoteDeploySection`
    - `DeploymentDetail.Section` "Output" → `OutputSection`
    - `ClientFields.Resolve` "client:deploy.deployments:release" → `ReleaseFieldResolver`
    - `FieldPresentation.Register` "client:deploy.deployments:release"
  - Uses: 35 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/live-state` ×6
    - `network/live` ×4
    - `primitives/setup-steps` ×4
    - `apps/deploy/health` ×3
    - `apps/deploy/deployments` ×2
    - `primitives/view-switcher` ×2
    - `infra/endpoints.useEndpointMutation`
    - `primitives/css/badge.Badge`
    - `primitives/css/bouncing-dots.BouncingDots`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/link-chip.LinkChip`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/spacing.Stack`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/loading.Loading`
    - `primitives/log-channels.LiveLogChannel`
    - `primitives/relative-time.RelativeTime`
    - `ui/icons.Icon`
- Core:
  - Uses:
    - `apps/deploy/deployments.deployments`
    - `fields/text/config.enumTextField`
    - `network/live.clientFields`
  - Exports (types):
    - `ReleaseState`
    - `ReleaseStateInput`
  - Exports (values):
    - `candidatePredatesLatest`
    - `RELEASE_STATE_OPTIONS`
    - `releaseFields`
    - `releaseStateLabel`
    - `resolveReleaseState`
    - `shortSha`
    - `stalenessChipLabel`
    - `stalenessSentence`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --info`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`

<!-- AUTOGENERATED:END -->
