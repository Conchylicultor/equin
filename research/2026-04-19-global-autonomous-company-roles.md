# Autonomous Company — Roles & Functions

Part 1 of 4 on turning equin into a self-running company. See also:
- [Plugin primitive design](2026-04-19-global-autonomous-company-primitive.md)
- [Supporting infra concepts](2026-04-19-global-autonomous-company-infra.md)
- [Roadmap](2026-04-19-global-autonomous-company-roadmap.md)

## Context

equin today is a coding-agent manager: humans create tasks, agents execute them. The vision extends further — equin as the hub for a **self-running company** where agents handle not only engineering but marketing, support, ops, finance, and strategy, with humans supervising by exception.

This doc catalogs the full surface area: every function a real software company performs, reframed as agent roles. It does not specify how each role is implemented — that depends on the plugin primitive (part 2) and infra layer (part 3). It does specify *what* agents should be able to do, organized so the roadmap (part 4) can sequence them by blast radius.

## Organizing principle

A company's work splits along two axes:

- **Inward vs. outward**. Inward functions (analytics, docs, cost monitoring) have low blast radius — mistakes hurt internally. Outward functions (support replies, marketing posts, billing) reach customers; mistakes are public.
- **Tactical vs. strategic**. Tactical functions execute known workflows. Strategic functions generate goals from ambiguous signal.

Agents should land inward-tactical first (safe to automate), then outward-tactical (with human approval gates), then strategic (the hardest). This is the structure used in the roadmap.

---

## Functions

Each function below is one or more specialized agent roles. Each gets:
- **Purpose** — what the role exists to do
- **Typical inputs** — signals that wake it
- **Typical outputs** — artifacts or actions it produces
- **Default trust envelope** — `auto` / `review` / `approve` as a starting point (tunable per command; see part 2)

### Go-to-market

**Content marketing**
- Purpose: blog posts, SEO pages, landing copy, changelog announcements
- Inputs: product releases, support FAQs, competitor moves, topic calendar
- Outputs: drafts, published posts, social snippets
- Trust: drafts `auto`, publishing `review` → `auto` once quality validates

**Launches & PR**
- Purpose: Product Hunt, Hacker News, Reddit, Twitter/X launches; press outreach
- Inputs: release milestones, strategic priorities
- Outputs: launch copy, scheduled posts, press contact outreach, comment-thread moderation
- Trust: `approve` for initial posts (reputation at stake), `auto` for routine follow-up comments

**Growth experiments**
- Purpose: A/B tests, funnel tweaks, onboarding variants, referral loops
- Inputs: analytics signals, funnel drop-offs
- Outputs: experiment proposals, hypothesis docs, implemented variants, result writeups
- Trust: proposals `review`, implementation `auto` once approved, rollout `auto`

**Sales / outbound** (if B2B)
- Purpose: lead qualification, outbound sequences, demo scheduling, proposal drafts
- Inputs: enrichment signals, inbound leads, CRM state
- Outputs: qualified lead list, sequence sends, meeting bookings, proposal docs
- Trust: qualification `auto`, sends `review` (per-account, escalating with deal size), proposals `approve`

**Community**
- Purpose: Discord/forum moderation, answering user questions, event coordination
- Inputs: unanswered posts, flagged content, scheduled events
- Outputs: replies, moderation actions, event logistics
- Trust: answering `review` → `auto`; moderation `auto` for spam, `approve` for bans

### Customer-facing

**Support**
- Purpose: ticket triage, reproduction, resolution, escalation
- Inputs: inbound tickets (email, chat, form), bug reports
- Outputs: replies, reproduction steps, bug tasks filed internally, status updates
- Trust: tier-1 `auto`, tier-2+ `review`, enterprise `approve`; bug filing `auto`

**Success / onboarding**
- Purpose: welcome sequences, activation nudges, churn outreach, retention check-ins
- Inputs: signup events, usage drops, renewal dates
- Outputs: personalized emails, in-app nudges, outreach threads
- Trust: templated sends `auto`, personalized outreach `review`

**Documentation**
- Purpose: user guides, API refs, tutorials, changelogs, migration guides
- Inputs: code changes, support trends (recurring questions), release events
- Outputs: doc drafts, updates, new tutorials
- Trust: drafts `auto`, publishing `review` → `auto` once patterns settle

### Product intelligence

**User research synthesis**
- Purpose: turn interviews, surveys, and usage analytics into insight briefs
- Inputs: interview transcripts, survey responses, event streams
- Outputs: themes, personas, jobs-to-be-done writeups, prioritized pain points
- Trust: `auto` — internal artifacts

**Competitive intel**
- Purpose: track competitor releases, pricing, positioning
- Inputs: competitor blogs, changelogs, social, pricing pages
- Outputs: weekly briefs, alerts on material moves
- Trust: `auto`

**Roadmap curation**
- Purpose: convert signals (support, research, metrics, strategy) into prioritized specs
- Inputs: the above + current objectives
- Outputs: spec drafts, priority ranking, dependency graphs
- Trust: `review` — the roadmap is load-bearing for strategic autonomy

### Finance & legal

**Billing**
- Purpose: plan definitions, invoices, Stripe ops, dunning, refunds, plan changes
- Inputs: webhook events, customer requests, failed charges
- Outputs: invoice actions, dunning sequences, plan mutations, refund processing
- Trust: dunning `auto`, refunds under threshold `auto`, over threshold `approve`

**Accounting**
- Purpose: bookkeeping, expense classification, reconciliation, tax-prep handoff
- Inputs: bank feeds, Stripe payouts, expense receipts
- Outputs: categorized transactions, monthly close, tax-ready exports
- Trust: classification `auto`, close `review`

**Legal & compliance**
- Purpose: ToS/privacy drafts, DPAs, GDPR/SOC2 checklists, contract redlines
- Inputs: regulatory changes, enterprise contract requests, product changes with legal impact
- Outputs: doc drafts, redlines, checklists
- Trust: `approve` — legal exposure is high

### Ops & infra

**SRE / incident response**
- Purpose: monitoring, alerting, on-call triage, postmortems
- Inputs: metrics, log anomalies, health checks, user reports
- Outputs: alerts, mitigations, rollbacks, postmortem docs, follow-up tasks
- Trust: detection `auto`, remediation gradient — rollback `auto`, schema changes `approve`

**Security**
- Purpose: dependency audits, vulnerability triage, secret rotation, pen-test prep
- Inputs: CVE feeds, audit reports, incident signals
- Outputs: patched deps, rotation events, remediation tasks, audit-ready artifacts
- Trust: patching `review`, sensitive ops `approve`

**Cost / FinOps**
- Purpose: cloud spend, LLM spend, per-agent budgets, quota tuning
- Inputs: billing feeds, per-agent usage metrics
- Outputs: cost reports, anomaly alerts, budget-adjustment proposals
- Trust: reporting `auto`, cap enforcement `auto`, raising caps `approve`

**Analytics / BI**
- Purpose: dashboards, weekly metrics digests, anomaly detection
- Inputs: event streams, db snapshots, business metric definitions
- Outputs: dashboards, auto-generated reports, anomaly alerts
- Trust: `auto`

### Meta / HQ

**Strategy / goal-setting**
- Purpose: generate objectives from market signal + current state; set quarterly themes
- Inputs: competitive intel, user research, metrics, human constraints
- Outputs: proposed objectives, quarterly plans, kill/keep decisions on initiatives
- Trust: `approve` — this is where humans stay in the loop longest

**Agent HR**
- Purpose: evaluate agent output quality, retire/retrain underperforming roles, promote trust envelopes
- Inputs: event logs, human edit signals, outcome metrics per agent
- Outputs: agent evaluation reports, prompt/tooling updates, trust-envelope promotions
- Trust: evaluations `auto`, role retirement `review`, trust promotions `review`

**Agent recruiting**
- Purpose: when a function gap appears, spec and instantiate a new agent role
- Inputs: unmet task categories, failure modes of existing agents
- Outputs: new role specs (prompt + plugin scope + trust envelope), provisioned agent
- Trust: `approve` — adding new autonomous roles is a significant action

---

## What stays human (near-term)

Even at "minimal supervision," some things stay human by design:

- **Capital allocation** — signing off on meaningful spend increases, fundraising, M&A
- **Hiring humans** — if the company employs people, humans decide
- **Final call on existential decisions** — pivots, shutdowns, acquisitions
- **Legal signatures** — contracts with real liability
- **Crisis response** — when something is on fire publicly, a human speaks

Everything else should trend toward `auto` as the trust system validates quality over time.

---

## Key tensions to resolve in design

1. **Blast radius vs. velocity.** Tighter trust envelopes are safer but slower. The system must make promotion from `approve` → `auto` easy once an agent earns it.
2. **Specialization vs. generalism.** One agent per function is legible but silo'd; a generalist agent has more context but diffuse quality. Likely answer: specialized agents with shared memory (part 3).
3. **Consistency vs. responsiveness.** Outward voice must be consistent (brand); agents must respond fast to incoming events. Shared institutional memory + style guides address this.
4. **Autonomy vs. auditability.** Full autonomy needs perfect audit trails or you can't debug failures. This is cheap if built into the primitive from day one (part 2).

---

## How this doc is used

The roadmap (part 4) sequences these roles by phase. The plugin primitive (part 2) defines how each role's tools and UI get expressed. The infra layer (part 3) gives them the shared substrate — memory, trust, cost, audit — to operate safely.
