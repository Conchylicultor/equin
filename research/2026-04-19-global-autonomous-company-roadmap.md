# Autonomous Company — Roadmap

Part 4 of 4. See also:
- [Roles & functions](2026-04-19-global-autonomous-company-roles.md)
- [Plugin primitive design](2026-04-19-global-autonomous-company-primitive.md)
- [Supporting infra concepts](2026-04-19-global-autonomous-company-infra.md)

## Context

Turning Singularity into a self-running company is a multi-phase program. This doc sequences the work.

**Operating principle.** Each phase produces a *working autonomous company at its own scope*, not a half-built one waiting for the next phase. Progress is measured by one metric: **the fraction of the company's activity that needs human touch today**, trending toward zero.

**Dogfooding principle.** The first customer is always Singularity itself. A new role, plugin, or infra concept ships first by being used *on* Singularity's own development before being exposed outward.

---

## Phase 0 — Self-improving coding studio

**Goal.** Singularity can meaningfully improve itself without a human picking every task.

**Scope (handled by the user, per our discussion).**
- Manager-agent plugin — decomposes stated goals into tasks, assigns them
- Reviewer-agent plugin — independent critique as a quality gate before `./equin push`
- Objective layer — something above tasks (missions / OKRs) for the manager to optimize toward

**Exit criteria.** A stated objective ("improve plugin test coverage" or "reduce build time") produces a stream of manager-planned, agent-executed, reviewer-gated PRs with minimal human intervention. Slop is controlled by the review loop, not by human task-curation.

**What Phase 0 does *not* cover.** Anything outward-facing. The company at this point improves itself, but doesn't yet have customers, revenue, support, or marketing.

---

## Phase 1 — Unified plugin primitive

**Goal.** Every subsequent plugin — internal or external — has one primitive to target (see [part 2](2026-04-19-global-autonomous-company-primitive.md)).

**Deliverables.**
- Extend `plugin-core` with scope, typed-command-with-agent-projection, narrative bundle, trigger, trust envelope, event log hooks.
- Migrate 1–2 existing plugins (candidates: `tasks`, `docs-button`) to validate the shape.
- Build one greenfield plugin on the new primitive — the simplest possible one — to prove it.

**Exit criteria.** A new plugin can be added that the agent operates *and* the human monitors through the same primitive, in a day. The migration didn't regress existing UX.

**Why this before external functions.** Every external integration built before this primitive is one-off plumbing that gets rewritten. Doing them after the primitive means each one lands cleanly.

**Risk.** Scope creep. The primitive is load-bearing; there's a temptation to get it "perfect." Counter: start with the minimum set (commands + scopes + event log + one trust envelope level), ship it, iterate as real plugins surface gaps.

---

## Phase 2 — Observation & memory foundation

**Goal.** Before agents act on the world, they perceive it and remember.

**Deliverables (from [part 3](2026-04-19-global-autonomous-company-infra.md) minimum viable subset).**
- **Event log** — unified ordered stream per workspace, with replay UI
- **Institutional memory** — first version: brand voice, current priorities, engineering conventions. Living docs, agent-readable, human-editable.
- **Exception surface** — a single dashboard in the shell showing everything needing human attention
- **Rollback & kill switches** — per-plugin pause + global freeze

**Exit criteria.** Given any agent action, we can: replay it, explain it, roll it back, and stop the plugin that produced it.

**Why now.** Phase 3+ creates autonomous outward action. The substrate to observe, audit, and contain that action must exist *before* it ships, not after an incident forces it.

---

## Phase 3 — Inward-facing functions (low blast radius)

**Goal.** Ship the plugins where mistakes are cheap. The company gains self-awareness without touching users.

**Role order (see part 1).**
1. **Documentation** — docs drafts, changelogs, API refs. Closest to coding, easiest to validate.
2. **Analytics / BI** — dashboards, weekly digests. Read-only on existing systems.
3. **Cost / FinOps** — spend tracking, alerts. Also read-only initially.
4. **SRE / monitoring** — detection and alerting; no remediation yet.
5. **Institutional knowledge curation** — agents propose updates to the memory layer.

**Exit criteria.** The company has an agent-authored weekly state-of-the-company report. Docs are kept current automatically. Spend anomalies surface without human polling. No external user was affected by any of this.

---

## Phase 4 — Outward drafts, human sends

**Goal.** External surfaces, but with humans hitting "send." This stress-tests the trust envelope system.

**Role order.**
1. **Support** — draft replies queued for review; humans approve/edit/send. Template replies promote to `auto` first.
2. **Content marketing** — blog drafts, social drafts, changelog announcements.
3. **Community** — draft answers to forum/Discord questions.
4. **Success / onboarding** — draft personalized outreach.
5. **Sales outbound** (if applicable) — draft sequences.
6. **Billing operations** — draft refund responses, dunning copy; humans click through.

**Exit criteria.** Each role above has a measurable human-edit rate and resolution rate. Commands with edit rate below a threshold (say, <20% non-trivial edits over N instances) are candidates for promotion in Phase 5.

**Critical milestone.** Trust envelope promotion from `review` to `auto` happens for the first time in this phase. The mechanism (manual flip? automatic? gated by agent HR?) needs to be designed before this phase ships.

---

## Phase 5 — Autonomous outward action

**Goal.** Graduated promotion of Phase 4 surfaces to `auto`, category by category. Simultaneously, add the functions that are only sensible when other functions are live.

**Promotion order (easiest first).**
- Tier-1 support replies
- Changelog posts and routine blog publishing
- Community answers to common questions
- Templated onboarding emails
- Routine billing operations (dunning, small refunds)

**New functions activated.**
- **Growth experiments** — ship and measure A/B tests autonomously
- **Launches & PR** — major launches still `approve`; routine announcements `auto`
- **Legal & compliance** — still mostly `review`/`approve`; routine checklist items `auto`
- **Security** — dependency patches `auto`; sensitive remediations `approve`
- **SRE remediations** — rollback `auto`; destructive fixes `approve`
- **User research synthesis** — fully `auto` for internal artifacts

**Exit criteria.** Measurable metric: >50% of outward-facing customer interactions happen without human touch, with quality metrics (CSAT, churn, edit rate) non-regressing. The exception surface shows roughly dozens of approvals per week, not hundreds.

---

## Phase 6 — Strategic autonomy

**Goal.** Agents generate goals, not just execute them. Humans move to board-level oversight.

**Deliverables.**
- **Strategy / goal-setting** plugin — ingests competitive intel, user research, metrics; proposes quarterly themes and objectives for human approval.
- **Agent HR** — evaluates each agent role's quality over time; proposes retirements, prompt updates, trust promotions. Largely `auto` on proposals, `review` on retirements.
- **Agent recruiting** — when a function gap appears (unhandled event categories, persistent escalations), agents spec and instantiate new roles. `approve` gate (adding autonomous roles is significant).
- **Roadmap curation** — agent-owned, human-gated backlog prioritization.

**Exit criteria.** The human role is: set constraints, approve strategy, respond to exceptions, intervene in crises. Daily operations require no human touch most days.

---

## Cross-cutting tracks

These run throughout every phase, not as discrete phases themselves:

- **Trust & safety** — envelope system evolution, blast-radius caps, rollback testing, kill-switch drills
- **Secrets / auth** — per-plugin credential isolation added as each new external integration lands
- **Cost governance** — per-agent budgets and caps, expanding coverage each phase
- **Observability** — event log stays the source of truth; dashboards grow with each new role
- **Exception surface** — evolves from simple pending-approvals list to rich triage UX as volume grows
- **Evaluation framework** — scoring each agent role; feeds into trust envelope promotion in Phase 4+

---

## How to measure progress

One headline metric per phase:

| Phase | Metric | Target |
|---|---|---|
| 0 | Fraction of internal tasks requiring human planning | <50% |
| 1 | Time to add a new plugin with full UI + agent surface | <1 day |
| 2 | Mean time to diagnose an agent action from the event log | <5 min |
| 3 | Fraction of internal ops (docs, analytics, SRE detection) requiring human touch | <20% |
| 4 | Human edit rate on Phase-4 drafts | Trending down |
| 5 | Fraction of outward interactions without human touch | >50% |
| 6 | Days per month requiring any human operational action | <5 |

Plus one **North-Star metric** across all phases: **fraction of company activity requiring human touch**, reported weekly, trending toward zero.

---

## Sequencing risks

1. **Primitive churn.** If Phase 1's primitive shape changes after Phase 3 plugins exist, we pay migration cost. Mitigation: validate the primitive with 2–3 concrete plugins before declaring it stable.
2. **Trust envelope collapse.** If promotions happen too fast (or too slow), the system either goes rogue or never benefits from autonomy. Mitigation: evaluation framework in Phase 2, strict promotion criteria in Phase 4.
3. **Dogfood gap.** Outward functions have no obvious Singularity-internal analog (we have no paying customers to support). Mitigation: use the primitive internally first (e.g., "support" = triaging internal bug reports from agents) before pointing at external traffic.
4. **Infra debt.** If any of the [infra concepts](2026-04-19-global-autonomous-company-infra.md) is skipped in Phase 2, it's much more expensive to retrofit later. Mitigation: treat the minimum viable subset as a hard gate for Phase 3.
5. **Strategy prematurely autonomous.** Phase 6 is the most likely place for catastrophic drift. Mitigation: strategy stays `approve`-gated much longer than other functions — this is by design.

---

## What success looks like

A year or two from now, at the end of Phase 6, a typical week goes:

- The strategy agent proposes a shift in a product area based on usage signal. Human reviews, approves.
- The roadmap agent decomposes it into a quarter of objectives. Human spot-checks.
- The manager agent plans tasks. The reviewer agent gates merges. Build happens.
- Docs, changelogs, launch copy write themselves. Routine support handles itself.
- The exception dashboard shows ~5 items needing human input that week — an enterprise refund request, a sensitive legal redline, a major launch post, a security incident remediation, a strategic tradeoff the strategy agent flagged.
- The human spends half a day on those. The rest is up to them.

That is the target end state of the roadmap.
