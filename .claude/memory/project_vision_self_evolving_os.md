---
name: equin vision — Notion-like composable apps
description: Long-term vision for equin as a unified surface where agents dynamically compose user-tailored apps from building blocks (Notion-meets-WeChat model)
type: project
originSessionId: c863f1f5-473d-4e20-9f3c-f5a86ab12448
---
equin is heading toward a "Notion-like WeChat" model: a single unified surface where agents dynamically create apps on the fly, tailored to each user's unique use-case. Like Notion gives users composable building blocks (databases, pages, views) to fit their workflow, equin does this at the *app* level — composing whole apps per user, all inside one experience.

**Why:** Generic apps force users into one-size-fits-all workflows. Agents now make it feasible to generate per-user, per-use-case apps cheaply. The unified surface (WeChat-like) keeps the experience cohesive instead of fragmenting into many disconnected tools.

**How to apply:**
- Think of plugins as **composable building blocks**, not as separate sub-apps. The agent manager is one composition of blocks; future user-specific apps are other compositions of (mostly the same) blocks.
- Favor primitives that compose well (slots, schemas, shared resources) over features that own their own siloed UX.
- Design with "an agent will assemble this for an unknown future use-case" in mind — generic, addressable, declarative beats bespoke and imperative.
- Keep the surface unified: don't introduce navigation paradigms or shells that assume the user is in one specific app.
- Sidequests (and the agent manager itself) are early hand-built compositions; eventually agents do the composing.
