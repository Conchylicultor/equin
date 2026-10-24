# Workflows: Vision

## The Problem

Building a new app in equin today requires knowing the internals: the plugin system, slot architecture, server conventions, DB patterns, CLI commands. An experienced user can compose plugins and launch agents manually, but the knowledge barrier is high. There's no guided path from "I want an app that does X" to a working, deployed result.

More broadly, many multi-step processes in equin — onboarding, debugging, publishing, reviewing — follow a predictable pattern: gather context from the user, run agents, present results for review, iterate, execute. These are workflows that could be automated but aren't, because there's no infrastructure to chain together user interactions and agent actions into a coherent experience.

## Two Layers

### Layer 1: The Workflow Engine

A generic primitive for defining and executing multi-step workflows that mix:

- **User interactions** — forms, reviews, approvals, selections
- **Agent actions** — conversations that research, plan, implement, or validate
- **Logic** — branching, conditions, loops, parallel fan-out

Workflows are defined as an ordered chain of steps. Each step is a plugin that owns its own UI, execution logic, and completion semantics. The engine orchestrates: it walks the chain, suspends when a step needs user input or an agent to finish, and resumes when the step completes.

A workflow definition is a reusable template. A workflow execution is one run of that template, with its own state, inputs, and outputs flowing between steps. Executions can span hours or days — the engine is durable.

The engine is agnostic to what workflows do. It doesn't know about apps, plugins, or equin internals. It just runs step chains.

### Layer 2: The "Create App" Workflow

The first workflow built on the engine. Its goal: let anyone describe an app they want and have it built end-to-end, without knowing anything about equin's internals.

A possible step chain:

1. **Describe** (prompt-form step) — The user enters a natural language description of the app they want. Optional toggles: expert mode, target complexity, preferred style. No jargon, no plugin vocabulary.

2. **Explore & Propose** (agent step) — An agent researches the request: what existing plugins are relevant, what needs to be built, what the app could look like. Produces proposals — potentially with mocks, sketches, or dynamic UI — for the user to react to.

3. **Refine** (prompt-form step) — The user reviews proposals, gives feedback, picks a direction. This step might loop back to step 2 if the user wants more exploration.

4. **Plan** (agent step) — An agent produces a concrete implementation plan: which plugins to create, which slots to use, how to connect things, what the data model looks like. Estimates the number of agent sessions and approximate cost.

5. **Review Plan** (prompt-form step) — The user reviews the plan, approves or requests changes. Shows estimated cost/time.

6. **Execute** (agent step) — The plan is decomposed into tasks. Agents implement each task autonomously — creating plugins, writing server code, building UI, running builds. The user can monitor progress.

7. **Verify** (prompt-form step) — The user tests the result, provides feedback. Can loop back to step 6 for fixes.

8. **Ship** (agent step) — Final cleanup, push, deploy.

This is one workflow. Others could follow the same pattern:

- **Improve App** — Start from an existing app, describe what to change, agents plan and execute the delta
- **Debug Issue** — Describe a bug, agents reproduce, investigate, fix, verify
- **Publish Plugin** — Walk through pre-publish checks, documentation, marketplace submission
- **Onboard User** — Guided setup: connect accounts, configure preferences, seed initial data

## The Vision

The workflow engine turns equin from a tool that requires expertise into a platform that guides users through complex processes. The "Create App" workflow is the flagship: it closes the loop on equin's core promise — an app that builds apps.

But the engine is general-purpose. Any multi-step process that involves humans and agents can be expressed as a workflow. Over time, workflows themselves become shareable — definitions can be published to the plugin marketplace alongside the plugins they orchestrate.

The end state: users don't interact with plugins directly. They interact with workflows — guided experiences composed from plugins by agents, tailored to what they're trying to accomplish. The plugin system is the engine room; workflows are the bridge.
